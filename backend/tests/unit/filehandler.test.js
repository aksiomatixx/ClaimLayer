'use strict';

/**
 * Unit tests for services/filehandler.js
 * Points at the mock FileHandler server (port 8002).
 *
 * Each describe block resets the mock DB via DELETE /mock/reset
 * so tests don't bleed state into each other.
 */

const axios = require('axios');
const fh    = require('../../src/services/filehandler');

const FH_BASE = process.env.FILEHANDLER_BASE_URL || 'http://localhost:8002';

async function resetMock() {
  await axios.delete(`${FH_BASE}/mock/reset`).catch(() => {});
}

const SAMPLE_CLAIM = {
  claimNumber:  'HHW-TEST-001',
  firstName:    'Maria',
  lastName:     'Santos',
  dob:          '1981-03-15',
  employerName: 'BrightCare Home Health',
  dateOfInjury: '2026-04-01',
  bodyPart:     'Lumbar Spine',
  injuryType:   'Lifting Injury',
};

describe('createClaim', () => {
  beforeEach(resetMock);

  it('creates a claim and returns claimId + claimNumber', async () => {
    const result = await fh.createClaim(SAMPLE_CLAIM);
    expect(result.claimId).toBeDefined();
    expect(result.claimNumber).toBe('HHW-TEST-001');
    expect(result.status).toBe('open');
    expect(result.createdAt).toBeDefined();
  });

  it('returns 409 on duplicate claimNumber', async () => {
    await fh.createClaim(SAMPLE_CLAIM);
    await expect(fh.createClaim(SAMPLE_CLAIM)).rejects.toMatchObject({
      response: { status: 409 },
    });
  });
});

describe('setReserves', () => {
  let fhClaimId;

  beforeEach(async () => {
    await resetMock();
    const c = await fh.createClaim({ ...SAMPLE_CLAIM, claimNumber: 'HHW-TEST-002' });
    fhClaimId = c.claimId;
  });

  it('sets reserves and returns the new total', async () => {
    const result = await fh.setReserves(
      fhClaimId,
      { medical: 35000, indemnity: 22000, expense: 3200, reason: 'AI initial analysis' },
      'AI_ENGINE',
      null
    );
    expect(result.reserveId).toBeDefined();
    expect(result.newTotal).toBe(60200);
    expect(result.previousTotal).toBe(0);
    expect(result.change).toBe(60200);
  });

  it('can set reserves multiple times (full history retained)', async () => {
    await fh.setReserves(fhClaimId, { medical: 10000, indemnity: 5000, expense: 500, reason: 'Initial' }, 'AI_ENGINE', null);
    await fh.setReserves(fhClaimId, { medical: 35000, indemnity: 22000, expense: 3200, reason: 'Revised after PR-2' }, 'ADJUSTER', 'akash@homecaretpa.com');

    const ledger = await fh.getLedger(fhClaimId);
    const reserveEvents = ledger.events.filter(e => e.event_type === 'RESERVE_SET');
    expect(reserveEvents.length).toBe(2);
  });
});

describe('attachDocument', () => {
  let fhClaimId;

  beforeEach(async () => {
    await resetMock();
    const c = await fh.createClaim({ ...SAMPLE_CLAIM, claimNumber: 'HHW-TEST-003' });
    fhClaimId = c.claimId;
  });

  it('attaches a PDF document and returns documentId', async () => {
    const mockPdf = Buffer.from('%PDF-1.4 test document content');
    const result = await fh.attachDocument(
      fhClaimId,
      mockPdf,
      'AI_REASONING_PDF',
      'AI Decision Analysis — HHW-TEST-003',
      '2026-04-02'
    );
    expect(result.documentId).toBeDefined();
    expect(result.docType).toBe('AI_REASONING_PDF');
    expect(result.fileSizeBytes).toBe(mockPdf.length);
  });
});

describe('createDiary / completeDiary', () => {
  let fhClaimId;

  beforeEach(async () => {
    await resetMock();
    const c = await fh.createClaim({ ...SAMPLE_CLAIM, claimNumber: 'HHW-TEST-004' });
    fhClaimId = c.claimId;
  });

  it('creates a diary entry and returns diaryId', async () => {
    const result = await fh.createDiary(fhClaimId, {
      type:       'DWC1_ISSUE',
      dueDate:    '2026-04-02',
      assignedTo: 'system@homecaretpa.com',
      priority:   'HIGH',
      notes:      'DWC-1 must be issued within 1 business day',
    });
    expect(result.diaryId).toBeDefined();
    expect(result.status).toBe('open');
    expect(result.dueDate).toBe('2026-04-02');
  });

  it('completes a diary entry', async () => {
    const created = await fh.createDiary(fhClaimId, {
      type:     'PR2_FOLLOW_UP',
      dueDate:  '2026-04-09',
      priority: 'MEDIUM',
      notes:    'Follow up on PR-2',
    });

    const result = await fh.completeDiary(
      fhClaimId,
      created.diaryId,
      'PR-2 received via DxF — processed automatically',
      'SYSTEM'
    );
    expect(result.status).toBe('completed');
    expect(result.diaryId).toBe(created.diaryId);
  });
});

describe('recordPayment', () => {
  let fhClaimId;

  beforeEach(async () => {
    await resetMock();
    const c = await fh.createClaim({ ...SAMPLE_CLAIM, claimNumber: 'HHW-TEST-005' });
    fhClaimId = c.claimId;
  });

  it('records a TD payment and returns paymentId + checkNumber', async () => {
    const result = await fh.recordPayment(fhClaimId, {
      type:       'TD',
      amount:     500.50,
      payee:      'Maria Santos',
      taxId:      'XXX-XX-1234',
      periodFrom: '2026-04-01',
      periodTo:   '2026-04-07',
      checkDate:  '2026-04-08',
      memo:       'TD benefit — 7 days @ $500.50/wk',
    });
    expect(result.paymentId).toBeDefined();
    expect(result.checkNumber).toBeDefined();
    expect(result.amount).toBe(500.50);
    expect(result.status).toBe('issued');
  });
});

describe('getLedger', () => {
  let fhClaimId;

  beforeEach(async () => {
    await resetMock();
    const c = await fh.createClaim({ ...SAMPLE_CLAIM, claimNumber: 'HHW-TEST-006' });
    fhClaimId = c.claimId;
  });

  it('returns ledger with claim creation event', async () => {
    const ledger = await fh.getLedger(fhClaimId);
    expect(ledger.claimId).toBe(fhClaimId);
    expect(ledger.events).toBeInstanceOf(Array);
    expect(ledger.events.length).toBeGreaterThan(0);
    expect(ledger.events[0].event_type).toBe('CLAIM_CREATED');
  });

  it('ledger grows with each operation', async () => {
    await fh.setReserves(fhClaimId, { medical: 10000, indemnity: 5000, expense: 500, reason: 'Test' }, 'AI_ENGINE', null);
    await fh.createDiary(fhClaimId, { type: 'DWC1_ISSUE', dueDate: '2026-04-02', priority: 'HIGH', notes: 'Test' });
    await fh.recordPayment(fhClaimId, { type: 'TD', amount: 500, payee: 'Test', periodFrom: '2026-04-01', periodTo: '2026-04-07', checkDate: '2026-04-08', memo: 'Test' });

    const ledger = await fh.getLedger(fhClaimId);
    expect(ledger.events.length).toBeGreaterThanOrEqual(4); // create + reserve + diary + payment
    expect(ledger.totalPaid).toBe(500);
    expect(ledger.totalReserve).toBe(15500);
  });
});
