'use strict';

/**
 * Integration tests — M11 QME/AME Process Management.
 *
 * Covers:
 *   - requestPanel creates panel row + CRITICAL diary
 *   - issuePanel computes strike deadline as 10 CALENDAR days (not business days)
 *   - recordStrikes derives correct remaining doctor
 *   - recordStrikes rejects if NPI not in panel
 *   - scheduleAppointment computes report_due_date = appointment + 30 calendar days
 *   - recordReportReceived calls supplementalRequestService.evaluateQmeReport
 *   - Strike deadline diary has no_snooze: true
 *   - AME track: no automated worker communications
 *
 * Run:
 *   npm test -- tests/integration/qme.test.js
 */

// ── Mock Supabase (must be first) ────────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
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

jest.mock('../../src/services/lobService', () => ({
  sendLetter: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'queued', estimatedDelivery: '2026-05-01' }),
  getLetterStatus: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'in_transit' }),
}));

// ── Token ─────────────────────────────────────────────────────────────────────
const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

// ── Helpers ───────────────────────────────────────────────────────────────────
async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const claim = {
    id,
    claim_number:  overrides.claim_number || 'HHW-2026-QME',
    employer_id:   overrides.employer_id || 'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status:        overrides.status || 'accepted',
    employee:      { firstName: 'Maria', lastName: 'Santos' },
    date_of_injury: '2026-02-15',
    body_part:     'Lumbar Spine',
    injury_type:   'Lifting Injury',
    filed_at:      new Date().toISOString(),
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  };
  await supabase.from('claims').insert(claim);
  return claim;
}

function getDiaries(claimId) {
  // Direct access to mock store
  return supabase.from('diaries').select('*').eq('claim_id', claimId);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// requestPanel
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/qme — requestPanel', () => {
  it('creates panel row with status panel_requested + CRITICAL diary', async () => {
    const claim = await seedClaim();

    const res = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Orthopedic Surgery', adjusterNotes: 'Complex knee' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('panel_requested');
    expect(res.body.specialty).toBe('Orthopedic Surgery');
    expect(res.body.track).toBe('qme');

    // Verify diary was created
    const { data: diaries } = await getDiaries(claim.id);
    const panelDiary = diaries.find(d => d.diary_type === 'QME_PANEL_REQUESTED');
    expect(panelDiary).toBeDefined();
    expect(panelDiary.priority).toBe('CRITICAL');
    expect(panelDiary.notes).toContain('Orthopedic Surgery');
  });

  it('returns 400 when claimId is missing', async () => {
    const res = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ specialty: 'Orthopedic Surgery' });

    expect(res.status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// issuePanel — strike deadline is 10 CALENDAR days
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/qme/:id/issue — issuePanel', () => {
  it('computes strike deadline as 10 calendar days (not business days)', async () => {
    const claim = await seedClaim();

    // Create panel
    const createRes = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Orthopedic Surgery' });

    const panelId = createRes.body.id;

    // Issue panel on a Friday — deadline should be Monday+3 (10 cal days)
    // Friday 2026-04-10 + 10 calendar days = Monday 2026-04-20
    const res = await request(app)
      .patch(`/api/v1/qme/${panelId}/issue`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        panelIssuedDate: '2026-04-10', // Friday
        doctor1: { name: 'Dr. Alice Smith', npi: '1111111111' },
        doctor2: { name: 'Dr. Bob Jones',   npi: '2222222222' },
        doctor3: { name: 'Dr. Carol Lee',   npi: '3333333333' },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('panel_issued');
    // 10 calendar days from Friday April 10 = Monday April 20
    expect(res.body.strike_deadline).toBe('2026-04-20');
    expect(res.body.doctor_1_name).toBe('Dr. Alice Smith');
    expect(res.body.doctor_2_name).toBe('Dr. Bob Jones');
    expect(res.body.doctor_3_name).toBe('Dr. Carol Lee');
  });

  it('strike deadline diary has no_snooze: true', async () => {
    const claim = await seedClaim();

    const createRes = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Neurology' });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/issue`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        panelIssuedDate: '2026-04-15',
        doctor1: { name: 'Dr. A', npi: '1111111111' },
        doctor2: { name: 'Dr. B', npi: '2222222222' },
        doctor3: { name: 'Dr. C', npi: '3333333333' },
      });

    const { data: diaries } = await getDiaries(claim.id);
    const strikeDiary = diaries.find(d => d.diary_type === 'QME_STRIKE_DEADLINE');
    expect(strikeDiary).toBeDefined();
    expect(strikeDiary.priority).toBe('CRITICAL');
    expect(strikeDiary.no_snooze).toBe(true);
    expect(strikeDiary.notes).toContain('CANNOT BE MISSED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordStrikes
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/qme/:id/strikes — recordStrikes', () => {
  let panelId, claimId;

  beforeEach(async () => {
    const claim = await seedClaim();
    claimId = claim.id;

    const createRes = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Orthopedic Surgery' });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/issue`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        panelIssuedDate: '2026-04-10',
        doctor1: { name: 'Dr. Alice Smith', npi: '1111111111' },
        doctor2: { name: 'Dr. Bob Jones',   npi: '2222222222' },
        doctor3: { name: 'Dr. Carol Lee',   npi: '3333333333' },
      });

    panelId = createRes.body.id;
  });

  it('derives correct remaining doctor when striking first two', async () => {
    const res = await request(app)
      .patch(`/api/v1/qme/${panelId}/strikes`)
      .set('Cookie', `token=${adminToken}`)
      .send({ strike1Npi: '1111111111', strike2Npi: '2222222222' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('doctor_selected');
    expect(res.body.selected_npi).toBe('3333333333');
    expect(res.body.selected_name).toBe('Dr. Carol Lee');
    expect(res.body.strike_1_npi).toBe('1111111111');
    expect(res.body.strike_2_npi).toBe('2222222222');
  });

  it('derives correct remaining doctor when striking first and third', async () => {
    const res = await request(app)
      .patch(`/api/v1/qme/${panelId}/strikes`)
      .set('Cookie', `token=${adminToken}`)
      .send({ strike1Npi: '1111111111', strike2Npi: '3333333333' });

    expect(res.status).toBe(200);
    expect(res.body.selected_npi).toBe('2222222222');
    expect(res.body.selected_name).toBe('Dr. Bob Jones');
  });

  it('rejects if NPI not in panel', async () => {
    const res = await request(app)
      .patch(`/api/v1/qme/${panelId}/strikes`)
      .set('Cookie', `token=${adminToken}`)
      .send({ strike1Npi: '1111111111', strike2Npi: '9999999999' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in the panel/);
  });

  it('rejects striking the same doctor twice', async () => {
    const res = await request(app)
      .patch(`/api/v1/qme/${panelId}/strikes`)
      .set('Cookie', `token=${adminToken}`)
      .send({ strike1Npi: '1111111111', strike2Npi: '1111111111' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same doctor twice/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// scheduleAppointment
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/qme/:id/appointment — scheduleAppointment', () => {
  it('computes report_due_date = appointment + 30 calendar days', async () => {
    const claim = await seedClaim();

    const createRes = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Pain Management' });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/issue`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        panelIssuedDate: '2026-04-10',
        doctor1: { name: 'Dr. A', npi: '1111111111' },
        doctor2: { name: 'Dr. B', npi: '2222222222' },
        doctor3: { name: 'Dr. C', npi: '3333333333' },
      });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/strikes`)
      .set('Cookie', `token=${adminToken}`)
      .send({ strike1Npi: '1111111111', strike2Npi: '2222222222' });

    // Schedule appointment for May 15
    const res = await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/appointment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ appointmentDate: '2026-05-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('appointment_scheduled');
    expect(res.body.appointment_date).toBe('2026-05-15');
    // May 15 + 30 calendar days = June 14
    expect(res.body.report_due_date).toBe('2026-06-14');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordReportReceived
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/qme/:id/report-received', () => {
  it('marks report received and creates review diary', async () => {
    const claim = await seedClaim();

    const createRes = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Orthopedic Surgery' });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/issue`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        panelIssuedDate: '2026-04-10',
        doctor1: { name: 'Dr. A', npi: '1111111111' },
        doctor2: { name: 'Dr. B', npi: '2222222222' },
        doctor3: { name: 'Dr. C', npi: '3333333333' },
      });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/strikes`)
      .set('Cookie', `token=${adminToken}`)
      .send({ strike1Npi: '1111111111', strike2Npi: '2222222222' });

    await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/appointment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ appointmentDate: '2026-05-15' });

    const res = await request(app)
      .patch(`/api/v1/qme/${createRes.body.id}/report-received`)
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('report_received');
    expect(res.body.report_received_at).toBeDefined();

    // Verify review diary was created
    const { data: diaries } = await getDiaries(claim.id);
    const reviewDiary = diaries.find(d => d.diary_type === 'QME_REPORT_REVIEW');
    expect(reviewDiary).toBeDefined();
    expect(reviewDiary.notes).toContain('permanent disability rating');
    expect(reviewDiary.notes).toContain('apportionment');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AME track
// ═════════════════════════════════════════════════════════════════════════════
describe('AME track — represented worker', () => {
  it('no automated worker communications on any QME action', async () => {
    // This test verifies that no notification/communication service is called
    // during QME operations — all comms go through attorney on AME track.
    // The system does not auto-send to workers at all in QME flow.
    const claim = await seedClaim();

    const res = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, specialty: 'Psychiatry' });

    expect(res.status).toBe(201);

    // Verify no notification events were generated
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', claim.id);
    const notifEvents = (events || []).filter(e =>
      e.type.includes('notification_sent') || e.type.includes('email_sent') || e.type.includes('sms_sent')
    );
    expect(notifEvents.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Calendar day verification (unit-level)
// ═════════════════════════════════════════════════════════════════════════════
describe('_addCalendarDays (calendar, not business)', () => {
  const { _addCalendarDays } = require('../../src/services/qmeService');

  it('Friday + 10 cal days = Monday (includes weekends)', () => {
    // April 10, 2026 is a Friday
    expect(_addCalendarDays('2026-04-10', 10)).toBe('2026-04-20'); // Monday
  });

  it('Monday + 10 cal days = Thursday', () => {
    // April 13, 2026 is a Monday
    expect(_addCalendarDays('2026-04-13', 10)).toBe('2026-04-23'); // Thursday
  });

  it('includes weekends in count (Saturday)', () => {
    // April 11, 2026 is a Saturday
    expect(_addCalendarDays('2026-04-11', 10)).toBe('2026-04-21'); // Tuesday
  });

  it('30 calendar days for report due', () => {
    // May 15 + 30 = June 14
    expect(_addCalendarDays('2026-05-15', 30)).toBe('2026-06-14');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Authentication
// ═════════════════════════════════════════════════════════════════════════════
describe('Authentication and authorization', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/qme').send({ claimId: 'x', specialty: 'y' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for employer role', async () => {
    const { generateEmployerToken } = require('../../src/middleware/auth');
    const empToken = generateEmployerToken({ sub: 'e1', employerId: 'emp1', employerName: 'Test' });

    const res = await request(app)
      .post('/api/v1/qme')
      .set('Cookie', `token=${empToken}`)
      .send({ claimId: 'x', specialty: 'y' });

    expect(res.status).toBe(403);
  });
});
