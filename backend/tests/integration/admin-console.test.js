'use strict';

/**
 * Integration tests — M3 Admin Console endpoints.
 *
 * Covers:
 *   POST /api/v1/claims/:id/analyze        — trigger / cache AI analysis
 *   PATCH /api/v1/claims/:id/reserves      — adjuster reserve approval
 *   PATCH /api/v1/claims/:id/status        — status transitions
 *   GET  /api/v1/claims/:id/reasoning-pdf  — AI reasoning PDF download
 *   GET  /api/v1/claims/:id/diaries        — list claim diaries
 *   GET  /api/v1/claims                    — list with ?status= filter
 *   GET  /api/v1/auth/dev-session          — dev auto-login (non-production)
 *
 * Claims and diaries are seeded directly into the in-memory store.
 * aiService is mocked to avoid requiring ANTHROPIC_API_KEY.
 *
 * Run:
 *   npm test -- tests/integration/admin-console.test.js
 */

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken, generateMagicToken } = require('../../src/middleware/auth');
const claimService = require('../../src/services/claimService');
const aiService    = require('../../src/services/aiService');

jest.mock('../../src/services/aiService');
jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_mock', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));

// ── Tokens ────────────────────────────────────────────────────────────────────
const adminToken   = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });
const AUTH         = `Bearer ${adminToken}`;
const employerToken = generateMagicToken({ claimId: 'claim_admin_001', adpEmployeeId: 'EMP-001' });
const EMP_AUTH     = `Bearer ${employerToken}`;

// ── Seed helpers ──────────────────────────────────────────────────────────────
const CLAIM_ID      = 'claim_admin_001';
const CLAIM_WITH_AI = 'claim_admin_ai';

function seedBasicClaim() {
  return claimService._seedClaim({
    id:            CLAIM_ID,
    claimNumber:   'HHW-2026-ADM01',
    employerId:    'employer-test',
    status:        'new_claim',
    diaries:       [],
    employee: {
      adpEmployeeId: 'EMP-001',
      firstName:     'Test',
      lastName:      'Employee',
      dob:           '1985-06-15',
    },
    dateOfInjury:      '2026-04-01',
    bodyPart:          'Left Knee',
    injuryType:        'Slip & Fall',
    injuryDescription: 'Slipped on wet tile while assisting patient.',
    aww:               800,
    tdRate:            533.33,
    filehandlerId:     'fh_mock_001',
    aiAnalysis:        null,
    priority:          null,
    createdAt:         new Date().toISOString(),
    updatedAt:         new Date().toISOString(),
    events:            [],
  });
}

function seedClaimWithAI() {
  return claimService._seedClaim({
    id:            CLAIM_WITH_AI,
    claimNumber:   'HHW-2026-ADM02',
    employerId:    'employer-test',
    status:        'intake_complete',
    diaries: [
      {
        diaryId:    'diy_001',
        type:       'DWC1_ISSUE',
        dueDate:    '2026-04-02',
        assignedTo: 'system@homecaretpa.com',
        priority:   'HIGH',
        notes:      'DWC-1 must be issued within 1 business day',
        status:     'open',
        createdAt:  new Date().toISOString(),
      },
      {
        diaryId:    'diy_002',
        type:       'COMPENSABILITY_DECISION_DUE',
        dueDate:    '2026-07-01',
        assignedTo: 'system@homecaretpa.com',
        priority:   'CRITICAL',
        notes:      'LC §5402 — 90-day deadline',
        status:     'open',
        createdAt:  new Date().toISOString(),
      },
    ],
    employee: {
      adpEmployeeId: 'EMP-002',
      firstName:     'Jane',
      lastName:      'Smith',
      dob:           '1990-01-20',
    },
    dateOfInjury:      '2026-03-15',
    bodyPart:          'Right Shoulder',
    injuryType:        'Strain / Sprain',
    injuryDescription: 'Reached overhead to reposition patient, felt immediate shoulder pain.',
    aww:               950,
    tdRate:            633.33,
    filehandlerId:     'fh_mock_002',
    aiAnalysis: {
      compensability:            'Likely Compensable',
      compensabilityScore:       88,
      priority:                  'High',
      suggestedMedicalReserve:   15000,
      suggestedIndemnityReserve: 8000,
      suggestedExpenseReserve:   1500,
      redFlags:                  ['Prior shoulder injury (2024)'],
      nextActions:               ['Issue DWC-1', 'Authorize ortho consult'],
      rationale:                 'Clear AOE/COE mechanism. Shoulder strain in patient transfer worker.',
    },
    priority:   'High',
    createdAt:  new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
    events:     [],
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  claimService._resetClaims();
  jest.clearAllMocks();
  seedBasicClaim();
  seedClaimWithAI();
});

afterEach(() => {
  claimService._resetClaims();
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/claims/:id/analyze
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/claims/:id/analyze', () => {
  const MOCK_ANALYSIS = {
    compensability:            'Likely Compensable',
    compensabilityScore:       90,
    priority:                  'High',
    suggestedMedicalReserve:   12000,
    suggestedIndemnityReserve: 6000,
    suggestedExpenseReserve:   1200,
    redFlags:                  ['No prior claims'],
    nextActions:               ['Issue DWC-1', 'Order MRI'],
    rationale:                 'Clear work-related mechanism.',
  };

  it('returns 200 with aiAnalysis after calling AI service', async () => {
    aiService.analyzeCompensability.mockResolvedValue(MOCK_ANALYSIS);

    const res = await request(app)
      .post(`/api/v1/claims/${CLAIM_ID}/analyze`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.claimId).toBe(CLAIM_ID);
    expect(res.body.aiAnalysis).toMatchObject({ compensabilityScore: 90 });
    expect(res.body.priority).toBe('High');
    expect(aiService.analyzeCompensability).toHaveBeenCalledTimes(1);
  });

  it('returns cached aiAnalysis without re-calling AI', async () => {
    // CLAIM_WITH_AI already has aiAnalysis seeded
    const res = await request(app)
      .post(`/api/v1/claims/${CLAIM_WITH_AI}/analyze`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.aiAnalysis.compensabilityScore).toBe(88);
    expect(aiService.analyzeCompensability).not.toHaveBeenCalled();
  });

  it('returns 404 when claim does not exist', async () => {
    const res = await request(app)
      .post('/api/v1/claims/nonexistent-claim/analyze')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 403 when caller is not admin', async () => {
    const res = await request(app)
      .post(`/api/v1/claims/${CLAIM_ID}/analyze`)
      .set('Authorization', EMP_AUTH);

    expect(res.status).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post(`/api/v1/claims/${CLAIM_ID}/analyze`);

    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/claims/:id/reserves
// ═══════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/claims/:id/reserves', () => {
  it('returns 200 and updated claim on valid reserves', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_WITH_AI}/reserves`)
      .set('Authorization', AUTH)
      .send({ medical: 15000, indemnity: 8000, expense: 1500, reason: 'Adjuster approval' });

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reserves_approved' }),
      ])
    );
  });

  it('returns 400 when medical reserve is missing', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_WITH_AI}/reserves`)
      .set('Authorization', AUTH)
      .send({ indemnity: 8000, expense: 1500 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when reserve is negative', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_WITH_AI}/reserves`)
      .set('Authorization', AUTH)
      .send({ medical: -100, indemnity: 8000, expense: 1500 });

    expect(res.status).toBe(400);
  });

  it('returns 404 when claim not found', async () => {
    const res = await request(app)
      .patch('/api/v1/claims/nonexistent/reserves')
      .set('Authorization', AUTH)
      .send({ medical: 1000, indemnity: 500, expense: 100 });

    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not admin', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_WITH_AI}/reserves`)
      .set('Authorization', EMP_AUTH)
      .send({ medical: 1000, indemnity: 500, expense: 100 });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/claims/:id/status
// ═══════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/claims/:id/status', () => {
  it('returns 200 on valid transition (new_claim → intake_complete)', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_ID}/status`)
      .set('Authorization', AUTH)
      .send({ status: 'intake_complete' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('intake_complete');
    expect(res.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'status_changed', data: expect.objectContaining({ to: 'intake_complete' }) }),
      ])
    );
  });

  it('returns 400 on invalid transition (new_claim → closed)', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_ID}/status`)
      .set('Authorization', AUTH)
      .send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid.*transition/i);
  });

  it('returns 404 when claim not found', async () => {
    const res = await request(app)
      .patch('/api/v1/claims/nonexistent/status')
      .set('Authorization', AUTH)
      .send({ status: 'intake_complete' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when status value is not in enum', async () => {
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM_ID}/status`)
      .set('Authorization', AUTH)
      .send({ status: 'banana' });

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/claims/:id/reasoning-pdf
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/claims/:id/reasoning-pdf', () => {
  it('returns 200 PDF buffer when aiAnalysis is present', async () => {
    const res = await request(app)
      .get(`/api/v1/claims/${CLAIM_WITH_AI}/reasoning-pdf`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/reasoning_/);
    expect(res.body).toBeTruthy();
  });

  it('returns 400 when aiAnalysis is null', async () => {
    const res = await request(app)
      .get(`/api/v1/claims/${CLAIM_ID}/reasoning-pdf`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not yet available/i);
  });

  it('returns 404 when claim not found', async () => {
    const res = await request(app)
      .get('/api/v1/claims/nonexistent/reasoning-pdf')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/claims/:id/diaries
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/claims/:id/diaries', () => {
  it('returns 200 with diaries array for claim with diaries', async () => {
    const res = await request(app)
      .get(`/api/v1/claims/${CLAIM_WITH_AI}/diaries`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.diaries)).toBe(true);
    expect(res.body.diaries.length).toBe(2);
    expect(res.body.diaries[0]).toMatchObject({ type: 'DWC1_ISSUE', priority: 'HIGH' });
  });

  it('returns 200 with empty array for claim with no diaries', async () => {
    const res = await request(app)
      .get(`/api/v1/claims/${CLAIM_ID}/diaries`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.diaries).toEqual([]);
  });

  it('returns 404 when claim not found', async () => {
    const res = await request(app)
      .get('/api/v1/claims/nonexistent/diaries')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/claims — action queue filter
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/claims (admin)', () => {
  it('returns all claims for admin without filters', async () => {
    const res = await request(app)
      .get('/api/v1/claims')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(Array.isArray(res.body.claims)).toBe(true);
  });

  it('returns only new_claim claims when ?status=new_claim', async () => {
    const res = await request(app)
      .get('/api/v1/claims?status=new_claim')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.claims.every(c => c.status === 'new_claim')).toBe(true);
    expect(res.body.count).toBe(1);
  });

  it('returns only intake_complete claims when ?status=intake_complete', async () => {
    const res = await request(app)
      .get('/api/v1/claims?status=intake_complete')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.claims.every(c => c.status === 'intake_complete')).toBe(true);
  });

  it('returns 400 when status value is invalid', async () => {
    const res = await request(app)
      .get('/api/v1/claims?status=invalid_status')
      .set('Authorization', AUTH);

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/auth/dev-session
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/auth/dev-session', () => {
  it('returns 200 and sets cookie in test environment', async () => {
    const res = await request(app)
      .get('/api/v1/auth/dev-session');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role).toBe('admin');
    // Cookie should be set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies.some(c => c.startsWith('token='))).toBe(true);
  });
});
