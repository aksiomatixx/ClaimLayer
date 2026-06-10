'use strict';

/**
 * IDOR / claim-scope authorization — negative cross-claim tests for every
 * employee-facing route (Finding 1 of the production-hardening pass).
 *
 * Two employees on two different claims: each request that names (or
 * resolves to) the other employee's claim must come back 403 with the
 * uniform no-detail body. The same request against the caller's own
 * claim must pass the scope gate. Admin access must keep working.
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  }))
);

const request = require('supertest');
const app = require('../../src/index');
const { generateAdminToken, generateMagicToken, generateEmployerToken } = require('../../src/middleware/auth');
const claimService = require('../../src/services/claimService');
const db = require('../../src/services/db');

const CLAIM_A = 'claim_idor_a';
const CLAIM_B = 'claim_idor_b';

function seed(id, employerId) {
  return claimService._seedClaim({
    id,
    claimNumber: `HHW-2026-${id.slice(-1).toUpperCase()}`,
    employerId,
    status: 'new_claim',
    employee: { adpEmployeeId: `ADP-${id}`, firstName: 'Test', lastName: 'Worker' },
    dateOfInjury: '2026-04-01',
    injuryDescription: 'Seeded claim for IDOR tests.',
    events: [],
    intakeProgress: {
      voice_complete: false, media_complete: false, mpn_acknowledged: false,
      provider_selected: false, appointment_confirmed: false, dwc1_generated: false,
    },
  });
}

const EMP_A = `Bearer ${generateMagicToken({ sub: 'emp-a', adpEmployeeId: 'ADP-A', claimId: CLAIM_A, employerId: 'employer-brightcare-001' })}`;
const EMP_B = `Bearer ${generateMagicToken({ sub: 'emp-b', adpEmployeeId: 'ADP-B', claimId: CLAIM_B, employerId: 'employer-carewell-001' })}`;
const ADMIN = `Bearer ${generateAdminToken({ sub: 'admin-1', email: 'admin@test' })}`;
const EMPLOYER_B = `Bearer ${generateEmployerToken({ sub: 'user-employer-2', email: 'hr@carewellservices.com', employerId: 'employer-carewell-001' })}`;

beforeEach(() => {
  seed(CLAIM_A, 'employer-brightcare-001');
  seed(CLAIM_B, 'employer-carewell-001');
});

afterEach(() => {
  db._reset();
  claimService._resetClaims();
});

function expectDenied(res) {
  expect(res.status).toBe(403);
  // The denial must not leak whether the resource exists or who owns it.
  expect(res.body).toEqual({ error: 'Access denied' });
}

// ── Claims ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/claims/:id', () => {
  it("cross-claim employee read is denied without detail", async () => {
    expectDenied(await request(app).get(`/api/v1/claims/${CLAIM_A}`).set('Authorization', EMP_B));
  });
  it('own-claim employee read works', async () => {
    const res = await request(app).get(`/api/v1/claims/${CLAIM_A}`).set('Authorization', EMP_A);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CLAIM_A);
  });
  it('admin read works', async () => {
    const res = await request(app).get(`/api/v1/claims/${CLAIM_A}`).set('Authorization', ADMIN);
    expect(res.status).toBe(200);
  });
  it('cross-tenant employer read is denied', async () => {
    expectDenied(await request(app).get(`/api/v1/claims/${CLAIM_A}`).set('Authorization', EMPLOYER_B));
  });
  it('a non-existent claim is denied for employees, not revealed as missing', async () => {
    expectDenied(await request(app).get('/api/v1/claims/claim_nope').set('Authorization', EMP_A));
  });
});

describe('GET /api/v1/claims (list)', () => {
  it('employees cannot enumerate claims', async () => {
    const res = await request(app).get('/api/v1/claims').set('Authorization', EMP_A);
    expect(res.status).toBe(403);
  });
  it('admin list keeps working', async () => {
    const res = await request(app).get('/api/v1/claims').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
  });
});

// ── DWC-1 ─────────────────────────────────────────────────────────────────────

describe('DWC-1 endpoints', () => {
  it('GET /:id/dwc1 cross-claim is denied', async () => {
    expectDenied(await request(app).get(`/api/v1/claims/${CLAIM_A}/dwc1`).set('Authorization', EMP_B));
  });
  it('GET /:id/dwc1 own claim passes the scope gate (404: not yet generated)', async () => {
    const res = await request(app).get(`/api/v1/claims/${CLAIM_A}/dwc1`).set('Authorization', EMP_A);
    expect(res.status).toBe(404);
  });
  it('POST /:id/dwc1/request-signature cross-claim is denied', async () => {
    expectDenied(await request(app)
      .post(`/api/v1/claims/${CLAIM_A}/dwc1/request-signature`).set('Authorization', EMP_B));
  });
  it('POST /:id/dwc1/request-signature own claim works', async () => {
    const res = await request(app)
      .post(`/api/v1/claims/${CLAIM_A}/dwc1/request-signature`).set('Authorization', EMP_A);
    expect(res.status).toBe(200);
  });
});

// ── Intake progress ───────────────────────────────────────────────────────────

describe('PATCH /api/v1/claims/:id/intake-progress', () => {
  it('cross-claim update is denied', async () => {
    expectDenied(await request(app)
      .patch(`/api/v1/claims/${CLAIM_A}/intake-progress`).set('Authorization', EMP_B)
      .send({ step: 'voice_complete', value: true }));
  });
  it('own-claim update works', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_A}/intake-progress`).set('Authorization', EMP_A)
      .send({ step: 'voice_complete', value: true });
    expect(res.status).toBe(200);
    expect(res.body.intake_progress.voice_complete).toBe(true);
  });
});

// ── Voice intake ──────────────────────────────────────────────────────────────

describe('voice intake routes', () => {
  const text = 'I hurt my lower back lifting a patient during a transfer with no mechanical assist.';

  it('POST /voice/text with another claim_id is denied', async () => {
    expectDenied(await request(app)
      .post('/api/v1/voice/text').set('Authorization', EMP_B)
      .send({ claim_id: CLAIM_A, text }));
  });
  it('POST /voice/text scoped to own claim works', async () => {
    const res = await request(app)
      .post('/api/v1/voice/text').set('Authorization', EMP_A)
      .send({ claim_id: CLAIM_A, text });
    expect(res.status).toBe(200);
  });
  it('POST /voice/transcribe with another claim_id is denied before any processing', async () => {
    const res = await request(app)
      .post('/api/v1/voice/transcribe').set('Authorization', EMP_B)
      .field('claim_id', CLAIM_A)
      .attach('audio', Buffer.from('fake-audio'), { filename: 'a.webm', contentType: 'audio/webm' });
    expectDenied(res);
  });
});

// ── Appointments ─────────────────────────────────────────────────────────────

describe('appointment routes', () => {
  it('POST /appointments for another claim is denied', async () => {
    expectDenied(await request(app)
      .post('/api/v1/appointments').set('Authorization', EMP_B)
      .send({ claim_id: CLAIM_A, provider_id: 'prov_001' }));
  });

  it('POST /appointments for own claim works', async () => {
    const res = await request(app)
      .post('/api/v1/appointments').set('Authorization', EMP_A)
      .send({ claim_id: CLAIM_A, provider_id: 'prov_001' });
    expect(res.status).toBe(201);
  });

  it('POST /:claimId/mpn-acknowledge cross-claim is denied', async () => {
    expectDenied(await request(app)
      .post(`/api/v1/appointments/${CLAIM_A}/mpn-acknowledge`).set('Authorization', EMP_B)
      .send({}));
  });

  it('PATCH /:id/confirm on an appointment belonging to another claim is denied', async () => {
    const create = await request(app)
      .post('/api/v1/appointments').set('Authorization', EMP_A)
      .send({ claim_id: CLAIM_A, provider_id: 'prov_001' });
    const apptId = create.body.appointment.id;

    expectDenied(await request(app)
      .patch(`/api/v1/appointments/${apptId}/confirm`).set('Authorization', EMP_B)
      .send({ confirmation_number: 'CONF-999' }));

    const ok = await request(app)
      .patch(`/api/v1/appointments/${apptId}/confirm`).set('Authorization', EMP_A)
      .send({ confirmation_number: 'CONF-999' });
    expect(ok.status).toBe(200);
  });
});

// ── Media documents ──────────────────────────────────────────────────────────

describe('document routes', () => {
  it('POST /documents/upload-url for another claim is denied', async () => {
    expectDenied(await request(app)
      .post('/api/v1/documents/upload-url').set('Authorization', EMP_B)
      .send({ claim_id: CLAIM_A, file_name: 'x.jpg', mime_type: 'image/jpeg', file_size_bytes: 100 }));
  });

  it('confirm-upload and metadata reads on another claim\'s document are denied', async () => {
    const issued = await request(app)
      .post('/api/v1/documents/upload-url').set('Authorization', EMP_A)
      .send({ claim_id: CLAIM_A, file_name: 'x.jpg', mime_type: 'image/jpeg', file_size_bytes: 100 });
    expect(issued.status).toBe(200);
    const docId = issued.body.document_id;

    expectDenied(await request(app)
      .post(`/api/v1/documents/${docId}/confirm-upload`).set('Authorization', EMP_B));
    expectDenied(await request(app)
      .get(`/api/v1/documents/${docId}`).set('Authorization', EMP_B));

    const ownRead = await request(app)
      .get(`/api/v1/documents/${docId}`).set('Authorization', EMP_A);
    expect(ownRead.status).toBe(200);

    const adminRead = await request(app)
      .get(`/api/v1/documents/${docId}`).set('Authorization', ADMIN);
    expect(adminRead.status).toBe(200);
  });
});
