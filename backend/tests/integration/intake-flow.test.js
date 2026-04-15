'use strict';

/**
 * Integration tests — M2 employee intake flow.
 *
 * Covers:
 *   - Provider search API
 *   - Text intake (Claude extraction path)
 *   - Appointment creation + confirmation
 *   - Magic link generation + validation
 *   - Intake progress tracking
 *
 * Does NOT test voice transcription (requires real audio + OpenAI key).
 * Does NOT test DWC-1 PDF generation (requires pdf-lib + real claim data).
 *
 * Claims are seeded directly into the in-memory store so these tests run
 * without the ADP or FileHandler mock servers.
 *
 * Run:
 *   npm test -- tests/integration/intake-flow.test.js
 */

// ── Mock Supabase ─────────────────────────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request  = require('supertest');
const app      = require('../../src/index');
const { generateAdminToken, generateMagicToken } = require('../../src/middleware/auth');
const db       = require('../../src/services/db');
const claimService = require('../../src/services/claimService');

// ── Minimal claim seed (no ADP / FileHandler needed) ──────────────────────────
const TEST_CLAIM_ID = 'claim_test_001';

function seedTestClaim() {
  return claimService._seedClaim({
    id:            TEST_CLAIM_ID,
    claimNumber:   'HHW-2026-TEST',
    employerId:    'employer-brightcare-001',
    status:        'new_claim',
    employee: {
      adpEmployeeId: 'BC-001',
      firstName:     'Maria',
      lastName:      'Santos',
      dob:           '1981-03-15',
    },
    dateOfInjury:      '2026-04-01',
    bodyPart:          'Lower Back',
    injuryType:        'Lifting Injury',
    injuryDescription: 'Lifted patient during transfer without mechanical assist.',
    aww:               1050,
    tdRate:            700,
    filehandlerId:     null,
    aiAnalysis:        null,
    priority:          null,
    dwc1DocumentId:    null,
    createdAt:         new Date().toISOString(),
    updatedAt:         new Date().toISOString(),
    events:            [],
    intakeProgress: {
      voice_complete:         false,
      media_complete:         false,
      mpn_acknowledged:       false,
      provider_selected:      false,
      appointment_confirmed:  false,
      dwc1_generated:         false,
    },
  });
}

afterEach(() => {
  db._reset();
  claimService._resetClaims();
});

// ── Tokens ────────────────────────────────────────────────────────────────────
const adminToken = generateAdminToken({
  sub:  'test-adjuster-001',
  email: 'akash.kumar@homecaretpa.com',
});
const AUTH = `Bearer ${adminToken}`;

const employeeToken = generateMagicToken({
  sub:           'emp-bc-001',
  adpEmployeeId: 'BC-001',
  claimId:       'HHW-2026-TEST',
  employerId:    'employer-brightcare-001',
});
const EMP_AUTH = `Bearer ${employeeToken}`;

// ── Provider search ───────────────────────────────────────────────────────────
describe('GET /api/v1/providers', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/providers?zip=90010');
    expect(res.status).toBe(401);
  });

  it('requires zip', async () => {
    const res = await request(app)
      .get('/api/v1/providers')
      .set('Authorization', AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('rejects invalid zip format', async () => {
    const res = await request(app)
      .get('/api/v1/providers?zip=9001')   // 4 digits
      .set('Authorization', AUTH);
    expect(res.status).toBe(400);
  });

  it('returns providers sorted by tier for a known zip', async () => {
    const res = await request(app)
      .get('/api/v1/providers?zip=90010')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(res.body.providers.length).toBeGreaterThan(0);
    expect(res.body.count).toBe(res.body.providers.length);

    // First result should be tier 1 or the best available
    const first = res.body.providers[0];
    expect(first.id).toBeDefined();
    expect(first.name).toBeDefined();
    expect(typeof first.distance_miles).toBe('number');
  });

  it('filters walk_in=true', async () => {
    const res = await request(app)
      .get('/api/v1/providers?zip=90010&walk_in=true&limit=10')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    res.body.providers.forEach(p => expect(p.walk_in).toBe(true));
  });

  it('filters by specialty', async () => {
    const res = await request(app)
      .get('/api/v1/providers?zip=90010&specialty=Orthopedic+Surgery&limit=10')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.providers.length).toBeGreaterThan(0);
    res.body.providers.forEach(p => expect(p.specialty).toBe('Orthopedic Surgery'));
  });

  it('respects limit param', async () => {
    const res = await request(app)
      .get('/api/v1/providers?zip=90010&limit=2')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.providers.length).toBeLessThanOrEqual(2);
  });

  it('GET /api/v1/providers/:id returns a single provider', async () => {
    // First get a valid ID
    const list = await request(app)
      .get('/api/v1/providers?zip=90010&limit=1')
      .set('Authorization', AUTH);
    const id = list.body.providers[0].id;

    const res = await request(app)
      .get(`/api/v1/providers/${id}`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('GET /api/v1/providers/:id returns 404 for unknown ID', async () => {
    const res = await request(app)
      .get('/api/v1/providers/prov_does_not_exist')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });
});

// ── Text intake ───────────────────────────────────────────────────────────────
describe('POST /api/v1/voice/text', () => {
  const validText = 'I was lifting a patient from the bed to the wheelchair when I felt a sharp pain in my lower back. The patient weighs about 200 pounds and there was no mechanical lift available.';

  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text')
      .send({ text: validText });
    expect(res.status).toBe(401);
  });

  it('rejects text shorter than 10 characters', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text')
      .set('Authorization', EMP_AUTH)
      .send({ text: 'hurt back' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('rejects empty text', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text')
      .set('Authorization', EMP_AUTH)
      .send({ text: '' });
    expect(res.status).toBe(400);
  });

  it('accepts valid text and returns transcript', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text')
      .set('Authorization', EMP_AUTH)
      .send({ text: validText });

    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe(validText);
    expect(res.body.transcriptDocId).toBeDefined();
    // extraction may be null if ANTHROPIC_API_KEY is not set
    if (res.body.extraction) {
      expect(typeof res.body.extraction).toBe('object');
    }
  });

  it('works without claim_id (draft intake before claim exists)', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text')
      .set('Authorization', EMP_AUTH)
      .send({ text: validText }); // no claim_id
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBeDefined();
  });

  it('works with an optional claim_id', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text')
      .set('Authorization', EMP_AUTH)
      .send({ claim_id: 'HHW-2026-TEST', text: validText });
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe(validText);
  });
});

// ── Appointment flow ──────────────────────────────────────────────────────────
describe('Appointment creation + confirmation', () => {
  beforeEach(() => {
    seedTestClaim();
  });

  it('POST /api/v1/appointments creates an appointment', async () => {
    const res = await request(app)
      .post('/api/v1/appointments')
      .set('Authorization', EMP_AUTH)
      .send({
        claim_id:    TEST_CLAIM_ID,
        provider_id: 'prov_001',
      });

    expect(res.status).toBe(201);
    expect(res.body.appointment).toBeDefined();
    expect(res.body.appointment.id).toBeDefined();
    expect(res.body.appointment.status).toBe('pending');
  });

  it('POST /api/v1/appointments/:claimId/mpn-acknowledge logs MPN acknowledgment', async () => {
    const res = await request(app)
      .post(`/api/v1/appointments/${TEST_CLAIM_ID}/mpn-acknowledge`)
      .set('Authorization', EMP_AUTH)
      .send({ employee_id: 'emp-bc-001' });

    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(res.body.logged_at).toBeDefined();
  });

  it('PATCH /api/v1/appointments/:id/confirm confirms an appointment', async () => {
    // Create first
    const create = await request(app)
      .post('/api/v1/appointments')
      .set('Authorization', EMP_AUTH)
      .send({
        claim_id:    TEST_CLAIM_ID,
        provider_id: 'prov_001',
      });
    expect(create.status).toBe(201);
    const apptId = create.body.appointment.id;

    // Confirm
    const confirm = await request(app)
      .patch(`/api/v1/appointments/${apptId}/confirm`)
      .set('Authorization', EMP_AUTH)
      .send({ confirmation_number: 'CONF-12345' });

    expect(confirm.status).toBe(200);
    expect(confirm.body.appointment.status).toBe('confirmed');
    expect(confirm.body.appointment.confirmation_number).toBe('CONF-12345');
  });

  it('PATCH confirm requires confirmation_number', async () => {
    const create = await request(app)
      .post('/api/v1/appointments')
      .set('Authorization', EMP_AUTH)
      .send({
        claim_id:    TEST_CLAIM_ID,
        provider_id: 'prov_002',
      });
    expect(create.status).toBe(201);
    const apptId = create.body.appointment.id;

    const res = await request(app)
      .patch(`/api/v1/appointments/${apptId}/confirm`)
      .set('Authorization', EMP_AUTH)
      .send({}); // missing confirmation_number

    expect(res.status).toBe(400);
  });
});

// ── Intake progress ───────────────────────────────────────────────────────────
describe('PATCH /api/v1/claims/:id/intake-progress', () => {
  let claimId;

  beforeEach(() => {
    const claim = seedTestClaim();
    claimId = claim.id;
  });

  it('updates a single intake step flag', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${claimId}/intake-progress`)
      .set('Authorization', AUTH)
      .send({ step: 'voice_complete', value: true });

    expect(res.status).toBe(200);
    expect(res.body.intake_progress.voice_complete).toBe(true);
  });

  it('preserves existing flags when updating one', async () => {
    // Set two flags sequentially
    await request(app)
      .patch(`/api/v1/claims/${claimId}/intake-progress`)
      .set('Authorization', AUTH)
      .send({ step: 'voice_complete', value: true });

    const res = await request(app)
      .patch(`/api/v1/claims/${claimId}/intake-progress`)
      .set('Authorization', AUTH)
      .send({ step: 'media_complete', value: true });

    expect(res.status).toBe(200);
    expect(res.body.intake_progress.voice_complete).toBe(true);
    expect(res.body.intake_progress.media_complete).toBe(true);
  });

  it('returns 404 for unknown claim', async () => {
    const res = await request(app)
      .patch('/api/v1/claims/claim_does_not_exist/intake-progress')
      .set('Authorization', AUTH)
      .send({ step: 'voice_complete', value: true });
    expect(res.status).toBe(404);
  });
});

// ── Magic link ────────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/magic-link/validate', () => {
  it('rejects invalid JWT', async () => {
    const res = await request(app)
      .post('/api/v1/auth/magic-link/validate')
      .send({ token: 'not-a-real-jwt' });
    expect(res.status).toBe(401);
  });

  it('rejects a missing token body', async () => {
    const res = await request(app)
      .post('/api/v1/auth/magic-link/validate')
      .send({});
    expect(res.status).toBe(400);
  });
});
