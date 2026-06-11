'use strict';

/**
 * M5 — Supabase Swap integration tests.
 *
 * Verifies that claimService and db.js correctly interact with the
 * Supabase mock, and that the mock itself behaves as expected.
 *
 * All tests use the in-memory supabaseClient mock — no real DB required.
 *
 * Run:
 *   npm test -- tests/integration/supabase-swap.test.js
 */

// ── Mock Supabase (must come first) ───────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

// ── Mock external services ────────────────────────────────────────────────────
jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({
    firstName: 'Maria', lastName: 'Santos', dob: '1981-03-15',
    associateOID: 'aoid-bc-001',
    address: { line1: '1234 Main St', city: 'Los Angeles', state: 'CA', zip: '90057' },
    phone: '(213) 555-1001', jobTitle: 'Home Health Aide II',
    hireDate: '2019-06-01', aww: 750.75, tdRate: 500.50, weeksCalculated: 26,
    payStatements: [],
  }),
}));

jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_sw_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_sw_mock', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_sw_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_sw_mock' }),
}));

jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn().mockResolvedValue(null),
}));

const request      = require('supertest');
const app          = require('../../src/index');
const claimService = require('../../src/services/claimService');
const db           = require('../../src/services/db');
const { supabase, supabaseAuth, _resetStore } = require('../__mocks__/supabaseClient');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'sw-admin', email: 'admin@homecaretpa.com' });
const AUTH       = `Bearer ${adminToken}`;

// ── Reset state between tests ─────────────────────────────────────────────────
beforeEach(() => {
  _resetStore();
  claimService._resetClaims();
});

afterEach(() => {
  _resetStore();
  claimService._resetClaims();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Mock infrastructure
// ═══════════════════════════════════════════════════════════════════════════════

describe('Supabase mock infrastructure', () => {
  it('rpc next_claim_number returns sequential HHW-YYYY-NNN strings', async () => {
    _resetStore(); // reset sequence
    const r1 = await supabase.rpc('next_claim_number');
    const r2 = await supabase.rpc('next_claim_number');
    const r3 = await supabase.rpc('next_claim_number');

    expect(r1.error).toBeNull();
    expect(r1.data).toMatch(/^HHW-\d{4}-\d{3}$/);
    expect(r2.data).not.toBe(r1.data); // each call increments
    expect(r3.data).not.toBe(r2.data);
  });

  it('insert + select round-trip works for claims table', async () => {
    const row = { id: 'cl_test_1', claim_number: 'HHW-2026-099', status: 'new_claim', employer_id: 'emp1' };
    await supabase.from('claims').insert(row);

    const { data, error } = await supabase
      .from('claims').select('*').eq('id', 'cl_test_1').single();

    expect(error).toBeNull();
    expect(data.id).toBe('cl_test_1');
    expect(data.claim_number).toBe('HHW-2026-099');
  });

  it('update modifies existing row', async () => {
    await supabase.from('claims').insert({ id: 'cl_upd', status: 'new_claim' });
    await supabase.from('claims').update({ status: 'accepted' }).eq('id', 'cl_upd');

    const { data } = await supabase.from('claims').select('*').eq('id', 'cl_upd').single();
    expect(data.status).toBe('accepted');
  });

  it('upsert inserts when no match on conflict key', async () => {
    await supabase.from('employees').upsert(
      { adp_employee_id: 'EMP-NEW', first_name: 'Test', last_name: 'Worker' },
      { onConflict: 'adp_employee_id' }
    );

    const { data } = await supabase
      .from('employees').select('*').eq('adp_employee_id', 'EMP-NEW').single();
    expect(data.first_name).toBe('Test');
  });

  it('upsert updates when conflict key matches', async () => {
    await supabase.from('employees').insert({ id: 'emp_1', adp_employee_id: 'EMP-EXIST', first_name: 'Old' });
    await supabase.from('employees').upsert(
      { adp_employee_id: 'EMP-EXIST', first_name: 'Updated' },
      { onConflict: 'adp_employee_id' }
    );

    const { data } = await supabase
      .from('employees').select('*').eq('adp_employee_id', 'EMP-EXIST').single();
    expect(data.first_name).toBe('Updated');
  });

  it('select returns [] when table is empty', async () => {
    const { data, error } = await supabase.from('reserves').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('select with joined relations attaches claim_events and diaries', async () => {
    await supabase.from('claims').insert({ id: 'cl_join', claim_number: 'HHW-2026-001' });
    await supabase.from('claim_events').insert({ claim_id: 'cl_join', type: 'claim_created', data: {}, timestamp: new Date().toISOString() });
    await supabase.from('diaries').insert({ claim_id: 'cl_join', diary_type: 'DWC1_ISSUE', due_date: '2026-04-02' });

    const { data } = await supabase
      .from('claims')
      .select('*, claim_events(*), diaries(*)')
      .eq('id', 'cl_join')
      .single();

    expect(data.claim_events).toHaveLength(1);
    expect(data.claim_events[0].type).toBe('claim_created');
    expect(data.diaries).toHaveLength(1);
    expect(data.diaries[0].diary_type).toBe('DWC1_ISSUE');
  });

  it('_resetStore clears all tables', async () => {
    await supabase.from('claims').insert({ id: 'cl_reset', claim_number: 'HHW-2026-002' });
    _resetStore();

    const { data } = await supabase.from('claims').select('*');
    expect(data).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. supabaseAuth mock
// ═══════════════════════════════════════════════════════════════════════════════

describe('supabaseAuth.auth.signInWithPassword', () => {
  it('returns user for valid employer credentials', async () => {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email:    'hr@brightcarehh.com',
      password: 'test1234',
    });
    expect(error).toBeNull();
    expect(data.user.email).toBe('hr@brightcarehh.com');
    expect(data.user.user_metadata.role).toBe('employer');
    expect(data.user.user_metadata.employer_id).toBe('employer-brightcare-001');
  });

  it('returns error for wrong password', async () => {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email:    'hr@brightcarehh.com',
      password: 'wrongpass',
    });
    expect(data).toBeNull();
    expect(error.message).toBeDefined();
  });

  it('returns error for unknown email', async () => {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email:    'nobody@example.com',
      password: 'test1234',
    });
    expect(data).toBeNull();
    expect(error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. claimService — full FROI flow via Supabase mock
// ═══════════════════════════════════════════════════════════════════════════════

describe('claimService.createClaim → Supabase', () => {
  it('creates a claim and persists it to the claims table', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', AUTH)
      .send({
        adpEmployeeId:     'BC-001',
        employerName:      'BrightCare Home Health',
        dateOfInjury:      '2026-04-01',
        bodyPart:          'Lower Back',
        injuryType:        'Lifting Injury',
        injuryDescription: 'Transferred patient.',
      });

    expect(res.status).toBe(201);
    expect(res.body.claimNumber).toMatch(/^HHW-\d{4}-\d{3}$/);
    expect(res.body.status).toBe('new_claim');

    // Verify persisted in Supabase mock
    const { data: row } = await supabase
      .from('claims').select('*').eq('id', res.body.id).single();
    expect(row).not.toBeNull();
    expect(row.claim_number).toBe(res.body.claimNumber);
  });

  it('claim_events are written for claim_created and adp_pull_complete', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', AUTH)
      .send({
        adpEmployeeId:     'BC-001',
        employerName:      'BrightCare',
        dateOfInjury:      '2026-04-01',
        bodyPart:          'Shoulder',
        injuryType:        'Strain',
        injuryDescription: 'Repetitive strain injury from patient repositioning.',
      });

    expect(res.status).toBe(201);

    const { data: events } = await supabase
      .from('claim_events').select('*').eq('claim_id', res.body.id);

    const types = events.map(e => e.type);
    expect(types).toContain('claim_created');
    expect(types).toContain('adp_pull_complete');
  });

  it('diaries are seeded in the diaries table when FH sync succeeds', async () => {
    const res = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', AUTH)
      .send({
        adpEmployeeId:     'BC-001',
        employerName:      'BrightCare',
        dateOfInjury:      '2026-04-01',
        bodyPart:          'Knee',
        injuryType:        'Fall',
        injuryDescription: 'Slipped on wet floor while assisting patient.',
      });

    expect(res.status).toBe(201);
    expect(res.body.filehandlerId).toBe('fh_sw_mock'); // FH mock returns this

    const { data: diaries } = await supabase
      .from('diaries').select('*').eq('claim_id', res.body.id);

    // Corrected compensability model (CL-DEC1): one initial 14-day
    // COMPENSABILITY_NOTICE_DUE diary — the 90-day diary only ever
    // exists after an explicit delay decision.
    expect(diaries.length).toBeGreaterThanOrEqual(5);
    const types = diaries.map(d => d.diary_type);
    expect(types).toContain('DWC1_ISSUE');
    expect(types).toContain('COMPENSABILITY_NOTICE_DUE');
    expect(types).not.toContain('COMPENSABILITY_DECISION_DUE');
    expect(types).not.toContain('DELAY_NOTICE_DUE');
  });

  it('getClaim assembles full claim with events and diaries', async () => {
    const createRes = await request(app)
      .post('/api/v1/claims')
      .set('Authorization', AUTH)
      .send({
        adpEmployeeId:     'BC-001',
        employerName:      'BrightCare',
        dateOfInjury:      '2026-04-01',
        bodyPart:          'Wrist',
        injuryType:        'Repetitive Motion',
        injuryDescription: 'Carpal tunnel.',
      });

    expect(createRes.status).toBe(201);
    const claim = await claimService.getClaim(createRes.body.id);

    expect(claim.events.length).toBeGreaterThan(0);
    expect(claim.diaries.length).toBeGreaterThan(0);
    expect(claim.employee.firstName).toBe('Maria');
    expect(claim.aww).toBeCloseTo(750.75, 1);
    expect(claim.tdRate).toBeCloseTo(500.50, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. db.js — Supabase-backed stores
// ═══════════════════════════════════════════════════════════════════════════════

describe('db.appointments — Supabase mock', () => {
  it('creates and retrieves an appointment', async () => {
    const appt = await db.appointments.create({
      claim_id:         'claim_x',
      provider_id:      'prov_001',
      appointment_date: '2026-05-01',
      appointment_time: '10:00',
      visit_type:       'initial_eval',
    });

    expect(appt.id).toBeDefined();
    expect(appt.claim_id).toBe('claim_x');

    const found = await db.appointments.findById(appt.id);
    expect(found.provider_id).toBe('prov_001');
  });

  it('findByClaim returns all appointments for a claim', async () => {
    await db.appointments.create({ claim_id: 'claim_y', provider_id: 'prov_002', visit_type: 'initial_eval', appointment_date: '2026-05-01', appointment_time: '09:00' });
    await db.appointments.create({ claim_id: 'claim_y', provider_id: 'prov_003', visit_type: 'follow_up',   appointment_date: '2026-05-15', appointment_time: '14:00' });
    await db.appointments.create({ claim_id: 'claim_z', provider_id: 'prov_004', visit_type: 'initial_eval', appointment_date: '2026-06-01', appointment_time: '11:00' });

    const appts = await db.appointments.findByClaim('claim_y');
    expect(appts).toHaveLength(2);
    appts.forEach(a => expect(a.claim_id).toBe('claim_y'));
  });
});

describe('db.documents — Supabase mock', () => {
  it('creates and retrieves a document', async () => {
    const doc = await db.documents.create({
      claim_id:  'claim_x',
      doc_type:  'voice_transcript',
      source:    'employee_upload',
      file_size_bytes: 2048,
    });

    expect(doc.id).toBeDefined();
    expect(doc.filehandler_pushed).toBe(false);

    const found = await db.documents.findById(doc.id);
    expect(found.doc_type).toBe('voice_transcript');
  });
});

describe('db.magicLinkTokens — Supabase mock', () => {
  it('create → findByJti → markUsed lifecycle', async () => {
    const jti = `jti_${Date.now()}`;
    await db.magicLinkTokens.create({
      jti,
      claim_id:        'cl_magic',
      adp_employee_id: 'BC-001',
      expires_at:      new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    });

    const record = await db.magicLinkTokens.findByJti(jti);
    expect(record.jti).toBe(jti);
    expect(record.used_at).toBeNull();

    await db.magicLinkTokens.markUsed(jti);

    const updated = await db.magicLinkTokens.findByJti(jti);
    expect(updated.used_at).not.toBeNull();
  });

  it('findByJti returns null for unknown jti', async () => {
    const result = await db.magicLinkTokens.findByJti('nonexistent-jti');
    expect(result).toBeNull();
  });
});

describe('db.employees — Supabase mock', () => {
  it('upsert creates a new employee record', async () => {
    const emp = await db.employees.upsert('EMP-TEST', {
      firstName: 'Jane', lastName: 'Doe', dob: '1990-01-01',
      address: { state: 'CA', zip: '90010' }, aww: 800, tdRate: 533.33, weeksCalculated: 26,
    });

    expect(emp.adpEmployeeId).toBe('EMP-TEST');
    expect(emp.firstName).toBe('Jane');
  });

  it('upsert updates existing employee on conflict', async () => {
    await db.employees.upsert('EMP-DUPE', { firstName: 'Original', lastName: 'Name' });
    await db.employees.upsert('EMP-DUPE', { firstName: 'Updated',  lastName: 'Name' });

    const emp = await db.employees.findByAdpId('EMP-DUPE');
    expect(emp.firstName).toBe('Updated');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Employer login via Supabase Auth
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/auth/employer/login — Supabase Auth', () => {
  it('returns 200 and sets cookie for valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/employer/login')
      .send({ email: 'hr@brightcarehh.com', password: 'test1234' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.employer_id).toBe('employer-brightcare-001');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 for wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/employer/login')
      .send({ email: 'hr@brightcarehh.com', password: 'badpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('returns 401 for unknown email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/employer/login')
      .send({ email: 'nobody@example.com', password: 'test1234' });

    expect(res.status).toBe(401);
  });
});
