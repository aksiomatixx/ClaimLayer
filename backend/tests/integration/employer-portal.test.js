'use strict';

/**
 * Integration tests — M4 Employer Portal endpoints.
 *
 * Covers:
 *   POST /api/v1/auth/employer/login           — credential validation + cookie
 *   GET  /api/v1/auth/dev-employer-session     — dev auto-login
 *   POST /api/v1/employer/froi                 — FROI submission → claim + magic link
 *   GET  /api/v1/employer/employee-preview/:id — ADP name preview
 *   GET  /api/v1/claims                        — employer RLS + admin bypass
 *   POST /api/v1/claims                        — bodyPart/injuryType now optional
 *
 * ADP and FileHandler are mocked so no external services are required.
 *
 * Run:
 *   npm test -- tests/integration/employer-portal.test.js
 */

const request      = require('supertest');
const app          = require('../../src/index');
const {
  generateAdminToken,
  generateEmployerToken,
  generateMagicToken,
} = require('../../src/middleware/auth');
const claimService = require('../../src/services/claimService');
const db           = require('../../src/services/db');

// ── Mock external services ────────────────────────────────────────────────────
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

const MOCK_EMPLOYEE = {
  associateOID:    'BC-001',
  adpEmployeeId:   'BC-001',
  firstName:       'Maria',
  lastName:        'Santos',
  dob:             '1985-03-12',
  email:           'msantos@brightcarehh.com',
  phone:           '(213) 555-1001',
  address:         { line1: '1234 Main St', city: 'Los Angeles', state: 'CA', zip: '90001' },
  jobTitle:        'Home Health Aide II',
  hireDate:        '2019-06-01',
  aww:             750.75,
  tdRate:          500.50,
  weeksCalculated: 52,
};

jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockImplementation(async (id) => {
    if (id === 'BC-001') return MOCK_EMPLOYEE;
    throw new Error(`Employee not found: ${id}`);
  }),
}));

// ── Tokens ────────────────────────────────────────────────────────────────────
const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

const employerToken = generateEmployerToken({
  sub:          'user-employer-1',
  email:        'hr@brightcarehh.com',
  employerId:   'employer-brightcare',
  employerName: 'BrightCare Home Health',
});

const employeeToken = generateMagicToken({
  claimId:       'claim_test',
  adpEmployeeId: 'BC-001',
  employerId:    'employer-brightcare',
});

// ── Helpers ───────────────────────────────────────────────────────────────────
beforeEach(() => {
  claimService._resetClaims();
  db._reset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1–3. POST /api/v1/auth/employer/login
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/auth/employer/login', () => {
  it('returns 200 and sets cookie on valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/employer/login')
      .send({ email: 'hr@brightcarehh.com', password: 'test1234' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.employer_id).toBe('employer-brightcare');
    expect(res.body.employer_name).toBe('BrightCare Home Health');
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.headers['set-cookie'][0]).toMatch(/token=/);
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/employer/login')
      .send({ email: 'hr@brightcarehh.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('returns 401 on unknown email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/employer/login')
      .send({ email: 'nobody@unknown.com', password: 'test1234' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4–5. GET /api/v1/auth/dev-employer-session
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/auth/dev-employer-session', () => {
  it('returns 200 with employer cookie in dev/test', async () => {
    const res = await request(app).get('/api/v1/auth/dev-employer-session');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role).toBe('employer');
    expect(res.body.employerId).toBe('employer-brightcare');
    expect(res.body.employerName).toBe('BrightCare Home Health');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 403 when NODE_ENV is production', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app).get('/api/v1/auth/dev-employer-session');
      expect(res.status).toBe(403);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6–12. POST /api/v1/employer/froi
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/employer/froi', () => {
  const validBody = {
    adpEmployeeId: 'BC-001',
    dateOfInjury:  '2026-04-01',
    bodyPart:      'Lumbar Spine',
    injuryType:    'Lifting Injury',
  };

  it('returns 201 with claim_number and magic_link_url for valid submission', async () => {
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .set('Cookie', `token=${employerToken}`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.claim_number).toMatch(/^HHW-/);
    expect(res.body.magic_link_url).toMatch(/\/claim\?t=/);
    expect(res.body.claim_id).toBeDefined();
    expect(res.body.employee_name).toBeTruthy();
    expect(res.body.expires_at).toBeDefined();
    expect(res.body.adp_data).toBeDefined();
    expect(res.body.adp_data.aww).toBeGreaterThan(0);
  });

  it('returns 422 for unknown ADP employee ID', async () => {
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .set('Cookie', `token=${employerToken}`)
      .send({ ...validBody, adpEmployeeId: 'DOES-NOT-EXIST-999' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('employee_not_found');
  });

  it('returns 400 for future dateOfInjury', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .set('Cookie', `token=${employerToken}`)
      .send({ ...validBody, dateOfInjury: future });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 when adpEmployeeId is missing', async () => {
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .set('Cookie', `token=${employerToken}`)
      .send({ dateOfInjury: '2026-04-01' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 401 with no auth token', async () => {
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it('returns 201 when called with admin token', async () => {
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .set('Cookie', `token=${adminToken}`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.claim_number).toMatch(/^HHW-/);
  });

  it('returns 403 when called with employee token', async () => {
    const res = await request(app)
      .post('/api/v1/employer/froi')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send(validBody);

    expect(res.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13–14. GET /api/v1/employer/employee-preview/:adpEmployeeId
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/employer/employee-preview/:adpEmployeeId', () => {
  it('returns found: true with name and job title for BC-001', async () => {
    const res = await request(app)
      .get('/api/v1/employer/employee-preview/BC-001')
      .set('Cookie', `token=${employerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.first_name).toBeTruthy();
    expect(res.body.last_name).toBeTruthy();
    expect(res.body.job_title).toBeTruthy();
  });

  it('returns found: false (200) for unknown employee', async () => {
    const res = await request(app)
      .get('/api/v1/employer/employee-preview/UNKNOWN-999')
      .set('Cookie', `token=${employerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15–16. GET /api/v1/claims — employer RLS + admin bypass
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/claims — scope enforcement', () => {
  beforeEach(() => {
    // Seed two claims: one for employer-brightcare, one for a different employer
    claimService._seedClaim({
      id: 'claim_bright_001', claimNumber: 'HHW-2026-001',
      employerId: 'employer-brightcare', status: 'new_claim',
      createdAt: new Date().toISOString(), events: [], diaries: [],
    });
    claimService._seedClaim({
      id: 'claim_other_001', claimNumber: 'HHW-2026-002',
      employerId: 'employer-other', status: 'new_claim',
      createdAt: new Date().toISOString(), events: [], diaries: [],
    });
  });

  it('employer token returns only their own claims', async () => {
    const res = await request(app)
      .get('/api/v1/claims')
      .set('Cookie', `token=${employerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.claims.map(c => c.id);
    expect(ids).toContain('claim_bright_001');
    expect(ids).not.toContain('claim_other_001');
  });

  it('admin token returns all claims', async () => {
    const res = await request(app)
      .get('/api/v1/claims')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.claims.map(c => c.id);
    expect(ids).toContain('claim_bright_001');
    expect(ids).toContain('claim_other_001');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17–18. POST /api/v1/claims — bodyPart and injuryType now optional
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/claims — optional bodyPart/injuryType', () => {
  const baseBody = {
    adpEmployeeId:      'BC-001',
    employerName:       'BrightCare Home Health',
    dateOfInjury:       '2026-04-01',
    injuryDescription:  'Employee reported pain after lifting patient.',
  };

  it('returns 201 when bodyPart is omitted', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Cookie', `token=${adminToken}`)
      .send({ ...baseBody, injuryType: 'Strain / Sprain' });

    expect(res.status).toBe(201);
  });

  it('returns 201 when injuryType is omitted', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Cookie', `token=${adminToken}`)
      .send({ ...baseBody, bodyPart: 'Shoulder' });

    expect(res.status).toBe(201);
  });
});
