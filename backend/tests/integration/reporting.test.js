'use strict';

/**
 * Integration tests — M10 Reporting endpoints.
 *
 * Covers:
 *   GET /api/v1/employers/:id/loss-run              — loss run totals
 *   GET /api/v1/employers/:id/summary               — aggregate stats
 *   GET /api/v1/employers/:id/experience-mod-inputs  — e-mod data
 *   GET /api/v1/reports/cross-employer               — admin cross-employer view
 *   GET /api/v1/reports/missed-deadlines             — compliance violations
 *   Employer isolation: employer A cannot see employer B's data
 *   Admin can see all employers
 *
 * Run:
 *   npm test -- tests/integration/reporting.test.js
 */

// ── Mock Supabase (must be first) ────────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request      = require('supertest');
const app          = require('../../src/index');
const {
  generateAdminToken,
  generateEmployerToken,
} = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');

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

jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({
    associateOID: 'BC-001', firstName: 'Maria', lastName: 'Santos',
    dob: '1985-03-12', phone: '(213) 555-1001',
    address: { line1: '1234 Main St', state: 'CA', zip: '90001' },
    jobTitle: 'Home Health Aide II', hireDate: '2019-06-01',
    aww: 750.75, tdRate: 500.50, weeksCalculated: 52,
  }),
}));

// ── Tokens ────────────────────────────────────────────────────────────────────
const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

const employerAToken = generateEmployerToken({
  sub:          'user-employer-1',
  email:        'hr@brightcarehh.com',
  employerId:   'employer-brightcare-001',
  employerName: 'BrightCare Home Health',
});

const employerBToken = generateEmployerToken({
  sub:          'user-employer-2',
  email:        'hr@carewellservices.com',
  employerId:   'employer-carewell-001',
  employerName: 'CareWell Services',
});

// ── Helper: seed a claim directly into Supabase mock ─────────────────────────
async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const claim = {
    id,
    claim_number:       overrides.claim_number || `HHW-2026-${Math.floor(Math.random() * 900 + 100)}`,
    employer_id:        overrides.employer_id || 'employer-brightcare-001',
    employer_name:      overrides.employer_name || 'BrightCare Home Health',
    status:             overrides.status || 'accepted',
    employee:           overrides.employee || { firstName: 'Maria', lastName: 'Santos' },
    aww:                overrides.aww || 750.75,
    td_rate:            overrides.td_rate || 500.50,
    date_of_injury:     overrides.date_of_injury || '2026-02-15',
    body_part:          overrides.body_part || 'Lumbar Spine',
    injury_type:        overrides.injury_type || 'Lifting Injury',
    filed_at:           overrides.filed_at || new Date().toISOString(),
    ai_analysis:        overrides.ai_analysis || null,
    motor_vehicle_fields: overrides.motor_vehicle_fields || null,
    employer_contests:  overrides.employer_contests || false,
    subrogation_status: overrides.subrogation_status || null,
    created_at:         overrides.created_at || new Date().toISOString(),
    updated_at:         overrides.updated_at || new Date().toISOString(),
  };
  await supabase.from('claims').insert(claim);
  return claim;
}

async function seedReserve(claimId, overrides = {}) {
  const reserve = {
    id:          `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id:    claimId,
    medical:     overrides.medical ?? 5000,
    indemnity:   overrides.indemnity ?? 3000,
    expense:     overrides.expense ?? 1000,
    reason:      overrides.reason || 'Test reserve',
    source:      overrides.source || 'ADJUSTER',
    approved_by: overrides.approved_by || 'admin@homecaretpa.com',
    created_at:  overrides.created_at || new Date().toISOString(),
  };
  await supabase.from('reserves').insert(reserve);
  return reserve;
}

async function seedDiary(claimId, overrides = {}) {
  const diary = {
    id:          `diary_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id:    claimId,
    diary_type:  overrides.diary_type || 'TD_PAYMENT_SETUP',
    due_date:    overrides.due_date || '2026-03-01',
    assigned_to: overrides.assigned_to || 'system@homecaretpa.com',
    priority:    overrides.priority || 'HIGH',
    notes:       overrides.notes || 'Test diary',
    status:      overrides.status || 'open',
    created_at:  overrides.created_at || new Date().toISOString(),
  };
  await supabase.from('diaries').insert(diary);
  return diary;
}

async function seedRFA(overrides = {}) {
  const rfa = {
    id:              `rfa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id:        overrides.claim_id || 'claim_test',
    claim_number:    overrides.claim_number || 'HHW-2026-100',
    received_at:     overrides.received_at || new Date().toISOString(),
    response_due_at: overrides.response_due_at || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    decision:        overrides.decision || null,
    created_at:      overrides.created_at || new Date().toISOString(),
  };
  await supabase.from('rfas').insert(rfa);
  return rfa;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  supabase._resetStore(['claims', 'reserves', 'diaries', 'rfas', 'claim_events', 'employees']);
});

// ═════════════════════════════════════════════════════════════════════════════
// LOSS RUN
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/employers/:id/loss-run', () => {
  it('returns loss run with correct totals for employer', async () => {
    const claim = await seedClaim({ employer_id: 'employer-brightcare-001' });
    await seedReserve(claim.id, { medical: 5000, indemnity: 3000, expense: 1000 });

    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/loss-run')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.lossRun).toBeDefined();
    expect(res.body.count).toBe(1);

    const row = res.body.lossRun[0];
    expect(row.claimNumber).toBe(claim.claim_number);
    expect(row.worker).toBe('Maria Santos');
    expect(row.medical).toBe(5000);
    expect(row.indemnity).toBe(3000);
    expect(row.expense).toBe(1000);
    expect(row.totalIncurred).toBe(9000);
    expect(row.isOpen).toBe(true);
  });

  it('returns multiple claims with correct aggregate', async () => {
    const c1 = await seedClaim({ employer_id: 'employer-brightcare-001', claim_number: 'HHW-2026-101' });
    const c2 = await seedClaim({ employer_id: 'employer-brightcare-001', claim_number: 'HHW-2026-102', status: 'closed' });
    await seedReserve(c1.id, { medical: 2000, indemnity: 1000, expense: 500 });
    await seedReserve(c2.id, { medical: 3000, indemnity: 2000, expense: 800 });

    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/loss-run')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const open = res.body.lossRun.find(r => r.claimNumber === 'HHW-2026-101');
    const closed = res.body.lossRun.find(r => r.claimNumber === 'HHW-2026-102');
    expect(open.isOpen).toBe(true);
    expect(closed.isOpen).toBe(false);
    expect(open.totalIncurred).toBe(3500);
    expect(closed.totalIncurred).toBe(5800);
  });

  it('falls back to AI-suggested reserves when no adjuster reserves exist', async () => {
    await seedClaim({
      employer_id: 'employer-brightcare-001',
      ai_analysis: {
        suggestedMedicalReserve: 4000,
        suggestedIndemnityReserve: 2000,
        suggestedExpenseReserve: 500,
      },
    });

    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/loss-run')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(200);
    const row = res.body.lossRun[0];
    expect(row.totalIncurred).toBe(6500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYER ISOLATION
// ═════════════════════════════════════════════════════════════════════════════
describe('Employer isolation', () => {
  it('employer A cannot see employer B loss run', async () => {
    // Seed a claim for employer B
    await seedClaim({ employer_id: 'employer-carewell-001' });

    // Employer A tries to access employer B's data
    const res = await request(app)
      .get('/api/v1/employers/employer-carewell-001/loss-run')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/);
  });

  it('employer A cannot see employer B summary', async () => {
    const res = await request(app)
      .get('/api/v1/employers/employer-carewell-001/summary')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(403);
  });

  it('employer A cannot see employer B experience mod inputs', async () => {
    const res = await request(app)
      .get('/api/v1/employers/employer-carewell-001/experience-mod-inputs')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(403);
  });

  it('employer can see own data', async () => {
    await seedClaim({ employer_id: 'employer-brightcare-001' });

    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/loss-run')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ACCESS
// ═════════════════════════════════════════════════════════════════════════════
describe('Admin access', () => {
  it('admin can see any employer loss run', async () => {
    await seedClaim({ employer_id: 'employer-carewell-001' });

    const res = await request(app)
      .get('/api/v1/employers/employer-carewell-001/loss-run')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('admin can access cross-employer report', async () => {
    await seedClaim({ employer_id: 'employer-brightcare-001', employer_name: 'BrightCare Home Health' });
    await seedClaim({ employer_id: 'employer-carewell-001', employer_name: 'CareWell Services' });

    const res = await request(app)
      .get('/api/v1/reports/cross-employer')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.employers).toBeDefined();
    expect(res.body.employers.length).toBe(2);
    expect(res.body.totalAllClaims).toBe(2);
  });

  it('employer cannot access cross-employer report', async () => {
    const res = await request(app)
      .get('/api/v1/reports/cross-employer')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(403);
  });

  it('employer cannot access missed deadlines report', async () => {
    const res = await request(app)
      .get('/api/v1/reports/missed-deadlines')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYER SUMMARY
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/employers/:id/summary', () => {
  it('returns correct aggregate stats', async () => {
    const c1 = await seedClaim({ employer_id: 'employer-brightcare-001', status: 'accepted' });
    const c2 = await seedClaim({ employer_id: 'employer-brightcare-001', status: 'closed' });
    await seedReserve(c1.id, { medical: 5000, indemnity: 3000, expense: 1000 });
    await seedReserve(c2.id, { medical: 2000, indemnity: 1000, expense: 500 });

    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/summary')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.openClaimCount).toBe(1);   // accepted is open, closed is not
    expect(res.body.totalClaimCount).toBe(2);
    expect(res.body.totalIncurredYTD).toBe(12500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EXPERIENCE MOD INPUTS
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/employers/:id/experience-mod-inputs', () => {
  it('returns payroll and loss data by class code', async () => {
    await seedClaim({ employer_id: 'employer-brightcare-001' });

    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/experience-mod-inputs')
      .set('Cookie', `token=${employerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.payrollByClass).toBeDefined();
    expect(res.body.payrollByClass.length).toBe(3); // 3 class codes
    expect(res.body.trendData).toBeDefined();
    expect(res.body.trendData.length).toBe(5); // 5 years
    expect(res.body.totalPayroll).toBeGreaterThan(0);
    expect(res.body.totalPremium).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MISSED DEADLINE REPORT
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/reports/missed-deadlines', () => {
  it('flags TD late when TD diary open and filed >14 days ago', async () => {
    const filedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const claim = await seedClaim({
      employer_id: 'employer-brightcare-001',
      filed_at: filedAt,
    });
    await seedDiary(claim.id, {
      diary_type: 'TD_PAYMENT_SETUP',
      status: 'open',
      due_date: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    });

    const res = await request(app)
      .get('/api/v1/reports/missed-deadlines')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.totalViolations).toBeGreaterThanOrEqual(1);

    const tdViolation = res.body.violations.find(v => v.type === 'TD_LATE');
    expect(tdViolation).toBeDefined();
    expect(tdViolation.claimId).toBe(claim.id);
    expect(tdViolation.daysOverdue).toBeGreaterThanOrEqual(6);
    expect(tdViolation.penalty).toMatch(/10%/);
  });

  it('flags DWC-7 late when diary open and filed >5 days ago', async () => {
    const filedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const claim = await seedClaim({
      employer_id: 'employer-brightcare-001',
      filed_at: filedAt,
    });
    await seedDiary(claim.id, {
      diary_type: 'DWC7_NOTICE',
      status: 'open',
      due_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    });

    const res = await request(app)
      .get('/api/v1/reports/missed-deadlines')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    const dwc7 = res.body.violations.find(v => v.type === 'DWC7_LATE');
    expect(dwc7).toBeDefined();
    expect(dwc7.daysOverdue).toBeGreaterThanOrEqual(5);
  });

  it('flags RFA expired when response_due_at passed with no decision', async () => {
    await seedRFA({
      response_due_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      decision: null,
    });

    const res = await request(app)
      .get('/api/v1/reports/missed-deadlines')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    const rfaViolation = res.body.violations.find(v => v.type === 'RFA_EXPIRED');
    expect(rfaViolation).toBeDefined();
    expect(rfaViolation.daysOverdue).toBeGreaterThanOrEqual(2);
    expect(rfaViolation.penalty).toMatch(/deemed authorized/);
  });

  it('does not flag completed diaries as violations', async () => {
    const filedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const claim = await seedClaim({
      employer_id: 'employer-brightcare-001',
      filed_at: filedAt,
    });
    // Completed diary — should NOT be flagged
    await seedDiary(claim.id, {
      diary_type: 'TD_PAYMENT_SETUP',
      status: 'completed',
      due_date: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    });

    const res = await request(app)
      .get('/api/v1/reports/missed-deadlines')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    const tdViolation = res.body.violations.find(v => v.type === 'TD_LATE' && v.claimId === claim.id);
    expect(tdViolation).toBeUndefined();
  });

  it('does not flag RFA with a decision as expired', async () => {
    await seedRFA({
      response_due_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      decision: 'approved',
    });

    const res = await request(app)
      .get('/api/v1/reports/missed-deadlines')
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    const rfaViolation = res.body.violations.find(v => v.type === 'RFA_EXPIRED');
    expect(rfaViolation).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════════
describe('Authentication required', () => {
  it('returns 401 without token', async () => {
    const res = await request(app)
      .get('/api/v1/employers/employer-brightcare-001/loss-run');

    expect(res.status).toBe(401);
  });

  it('returns 401 for cross-employer without token', async () => {
    const res = await request(app)
      .get('/api/v1/reports/cross-employer');

    expect(res.status).toBe(401);
  });
});
