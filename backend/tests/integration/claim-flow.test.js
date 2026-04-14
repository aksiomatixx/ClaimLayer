'use strict';

/**
 * Integration test — full FROI → claim creation flow.
 *
 * Requires both mock servers running:
 *   python backend/mocks/mock_adp.py         (port 8001)
 *   python backend/mocks/mock_filehandler.py  (port 8002)
 *
 * ANTHROPIC_API_KEY must be set for the AI analysis assertions.
 * If unset, the AI step is skipped with a warning.
 *
 * Run:
 *   npm test -- tests/integration/claim-flow.test.js
 */

const request = require('supertest');
const app     = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');

// ── Test JWT ──────────────────────────────────────────────────────────────────
const adminToken = generateAdminToken({
  sub:        'test-adjuster-001',
  email:      'akash.kumar@homecaretpa.com',
  employerId: 'employer-brightcare-001',
});

const authHeader = `Bearer ${adminToken}`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('Health check', () => {
  it('GET /health → 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('POST /api/v1/claims — validation', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/v1/claims').send({});
    expect(res.status).toBe(401);
  });

  it('rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', authHeader)
      .send({ adpEmployeeId: 'BC-001' }); // missing other required fields
    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it('rejects invalid dateOfInjury format', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', authHeader)
      .send({
        adpEmployeeId:    'BC-001',
        employerName:     'BrightCare Home Health',
        dateOfInjury:     'April 1 2026', // wrong format
        bodyPart:         'Lower Back',
        injuryType:       'Lifting Injury',
        injuryDescription: 'Patient transfer injury',
      });
    expect(res.status).toBe(400);
  });
});

describe('Full FROI → claim creation flow', () => {
  let createdClaim;

  it('creates a claim for BC-001 (Maria Santos — standard lifting injury)', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', authHeader)
      .send({
        adpEmployeeId:    'BC-001',
        employerName:     'BrightCare Home Health',
        dateOfInjury:     '2026-04-01',
        bodyPart:         'Lumbar Spine / Lower Back',
        injuryType:       'Lifting Injury',
        injuryDescription: 'Injured lower back while transferring patient from bed to wheelchair during morning care routine.',
      });

    expect(res.status).toBe(201);

    createdClaim = res.body;

    // Claim structure
    expect(createdClaim.id).toBeDefined();
    expect(createdClaim.claimNumber).toMatch(/^HHW-\d{4}-\d{3}$/);
    expect(createdClaim.status).toBe('pending');

    // ADP data pulled correctly
    expect(createdClaim.employee.firstName).toBe('Maria');
    expect(createdClaim.employee.lastName).toBe('Santos');
    expect(createdClaim.employee.dob).toBe('1981-03-15');
    expect(createdClaim.employee.jobTitle).toBeDefined();

    // AWW and TD rate calculated
    expect(createdClaim.aww).toBeGreaterThan(0);
    expect(createdClaim.tdRate).toBeGreaterThanOrEqual(252.03);   // CA 2026 floor
    expect(createdClaim.tdRate).toBeLessThanOrEqual(1680.29);     // CA 2026 ceiling

    // FileHandler sync — claim should have an fhId (or a failed-sync event)
    const hasFHId    = !!createdClaim.filehandlerId;
    const hasFHEvent = createdClaim.events.some(e =>
      e.type === 'filehandler_claim_created' || e.type === 'filehandler_sync_failed'
    );
    expect(hasFHEvent).toBe(true);

    if (hasFHId) {
      // Diaries should have been seeded
      const diaryEvents = createdClaim.events.filter(e => e.type === 'diary_created');
      expect(diaryEvents.length).toBeGreaterThanOrEqual(3); // DWC1, TD, PR2, DWC7
    }

    console.log(`  ✓ Claim created: ${createdClaim.claimNumber} (FH: ${createdClaim.filehandlerId || 'pending'})`);
    console.log(`  ✓ AWW: $${createdClaim.aww} / TD: $${createdClaim.tdRate}/wk`);
  }, 20_000);

  it('GET /api/v1/claims/:id retrieves the created claim', async () => {
    if (!createdClaim) return;

    const res = await request(app)
      .get(`/api/v1/claims/${createdClaim.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdClaim.id);
    expect(res.body.claimNumber).toBe(createdClaim.claimNumber);
  });

  it('GET /api/v1/claims lists claims', async () => {
    const res = await request(app)
      .get('/api/v1/claims')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.claims).toBeInstanceOf(Array);
    expect(res.body.count).toBeGreaterThan(0);
  });

  it('waits for async AI analysis to complete (if ANTHROPIC_API_KEY set)', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('  ⚠ ANTHROPIC_API_KEY not set — skipping AI analysis assertion');
      return;
    }
    if (!createdClaim) return;

    // AI analysis runs via setImmediate — give it up to 25 s
    let claim;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const res = await request(app)
        .get(`/api/v1/claims/${createdClaim.id}`)
        .set('Authorization', authHeader);
      claim = res.body;
      if (claim.aiAnalysis) break;
    }

    expect(claim.aiAnalysis).not.toBeNull();
    expect(['Likely Compensable', 'Questionable', 'Non-Compensable'])
      .toContain(claim.aiAnalysis.compensability);
    expect(claim.aiAnalysis.compensabilityScore).toBeGreaterThanOrEqual(0);
    expect(claim.aiAnalysis.compensabilityScore).toBeLessThanOrEqual(100);
    expect(claim.aiAnalysis.suggestedMedicalReserve).toBeGreaterThan(0);
    expect(['Critical', 'High', 'Medium', 'Low']).toContain(claim.aiAnalysis.priority);
    expect(claim.aiAnalysis.redFlags).toBeInstanceOf(Array);
    expect(claim.aiAnalysis.nextActions).toBeInstanceOf(Array);

    console.log(`  ✓ AI: ${claim.aiAnalysis.compensability} (score: ${claim.aiAnalysis.compensabilityScore})`);
    console.log(`  ✓ Reserves: Med $${claim.aiAnalysis.suggestedMedicalReserve} / Ind $${claim.aiAnalysis.suggestedIndemnityReserve}`);
    console.log(`  ✓ Priority: ${claim.aiAnalysis.priority}`);
  }, 30_000);
});

describe('TD rate edge cases', () => {
  it('CW-007 (Thanh Nguyen — part-time) hits CA TD minimum floor', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', authHeader)
      .send({
        adpEmployeeId:    'CW-007',
        employerName:     'CareWell Services',
        dateOfInjury:     '2026-04-01',
        bodyPart:         'Shoulder',
        injuryType:       'Repetitive Motion',
        injuryDescription: 'Repetitive strain to right shoulder from repeated patient repositioning over several months.',
      });

    expect(res.status).toBe(201);
    expect(res.body.tdRate).toBe(252.03); // floor applied
    console.log(`  ✓ TD floor: AWW $${res.body.aww} → TD $${res.body.tdRate} (floor applied)`);
  }, 20_000);

  it('BC-099 (Priya Krishnamurthy — RN) hits CA TD maximum ceiling', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', authHeader)
      .send({
        adpEmployeeId:    'BC-099',
        employerName:     'BrightCare Home Health',
        dateOfInjury:     '2026-04-01',
        bodyPart:         'Wrist / Hand',
        injuryType:       'Repetitive Motion',
        injuryDescription: 'Carpal tunnel syndrome from extended documentation and IV administration duties.',
      });

    expect(res.status).toBe(201);
    expect(res.body.tdRate).toBe(1680.29); // ceiling applied
    console.log(`  ✓ TD ceiling: AWW $${res.body.aww} → TD $${res.body.tdRate} (ceiling applied)`);
  }, 20_000);
});

describe('Reserve approval flow', () => {
  it('adjuster can approve reserves on a claim with FileHandler ID', async () => {
    // Create a claim first
    const createRes = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', authHeader)
      .send({
        adpEmployeeId:    'SR-022',
        employerName:     'SunRise Home Care',
        dateOfInjury:     '2026-04-01',
        bodyPart:         'Knee',
        injuryType:       'Fall',
        injuryDescription: 'Slipped on wet floor at patient residence causing medial meniscus tear.',
      });

    expect(createRes.status).toBe(201);
    const claimId    = createRes.body.id;
    const hasFilehandlerId = !!createRes.body.filehandlerId;

    if (!hasFilehandlerId) {
      console.warn('  ⚠ FileHandler sync failed — skipping reserve approval test');
      return;
    }

    const res = await request(app)
      .patch(`/api/v1/claims/${claimId}/reserves`)
      .set('Authorization', authHeader)
      .send({
        medical:   35000,
        indemnity: 22000,
        expense:   3200,
        reason:    'Adjuster review — surgical threshold case',
      });

    expect(res.status).toBe(200);
    const reserveEvent = res.body.events.find(e => e.type === 'reserves_approved');
    expect(reserveEvent).toBeDefined();
    expect(reserveEvent.data.approvedBy).toBe('akash.kumar@homecaretpa.com');
    console.log(`  ✓ Reserves approved: Med $35,000 / Ind $22,000 / Exp $3,200`);
  }, 20_000);
});

describe('Webhook receivers', () => {
  it('POST /webhooks/dxf/adt → 202 (no signature in dev)', async () => {
    const res = await request(app)
      .post('/webhooks/dxf/adt')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        eventType:         'ADT_A01',
        patientInternalId: 'HHW-2026-041',
        facilityName:      'Cedars-Sinai Medical Center',
        eventDateTime:     '2026-04-15T09:32:00Z',
      }));
    expect(res.status).toBe(202);
  });

  it('POST /webhooks/lob/delivery → 200', async () => {
    const res = await request(app)
      .post('/webhooks/lob/delivery')
      .send({
        id:         'ltr_mock123',
        event_type: 'letter.delivered',
        metadata:   { claim_id: 'HHW-2026-041', notice_type: 'DWC7' },
      });
    expect(res.status).toBe(200);
  });
});
