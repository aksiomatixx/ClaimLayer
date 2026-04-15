'use strict';

/**
 * Unit tests for services/filehandler.js
 *
 * Uses jest.mock('axios') with in-memory state — no external server required.
 * Call axios._resetState() between tests to clear the fake claim database.
 */

// ── Axios mock with in-memory FileHandler state ───────────────────────────────
jest.mock('axios', () => {
  // Shared mutable state — reset via _resetState()
  const state = { claims: {}, _id: 0 };

  function nextId(prefix) {
    return `${prefix}_${++state._id}`;
  }

  function resetState() {
    state.claims = {};
    state._id    = 0;
  }

  // Fake axios client returned by axios.create(...)
  const client = {
    // ── POST ───────────────────────────────────────────────────────────────────
    post: async (path, data) => {
      // POST /claims
      if (path === '/claims') {
        const { claimNumber } = data;
        const dup = Object.values(state.claims).find(c => c.claimNumber === claimNumber);
        if (dup) {
          const err = new Error('Duplicate claim number');
          err.response = { status: 409, data: { error: 'duplicate_claim_number' } };
          return Promise.reject(err);
        }
        const claimId = nextId('fh');
        state.claims[claimId] = {
          claimId,
          claimNumber,
          status:    'open',
          createdAt: new Date().toISOString(),
          events:    [{ event_type: 'CLAIM_CREATED', timestamp: new Date().toISOString() }],
          reserves:  [],
          diaries:   {},
          payments:  [],
        };
        return { data: state.claims[claimId] };
      }

      // POST /claims/:id/reserves
      const mRes = path.match(/^\/claims\/([^/]+)\/reserves$/);
      if (mRes) {
        const claimId  = mRes[1];
        const c        = state.claims[claimId];
        if (!c) { const e = new Error('Not found'); e.response = { status: 404 }; return Promise.reject(e); }
        const prevTotal = c.reserves.length ? c.reserves[c.reserves.length - 1].newTotal : 0;
        const newTotal  = (data.medicalReserve || 0) + (data.indemnityReserve || 0) + (data.expenseReserve || 0);
        const reserveId = nextId('res');
        c.reserves.push({ reserveId, newTotal, previousTotal: prevTotal, change: newTotal - prevTotal });
        c.events.push({ event_type: 'RESERVE_SET', timestamp: new Date().toISOString() });
        return { data: { reserveId, newTotal, previousTotal: prevTotal, change: newTotal - prevTotal } };
      }

      // POST /claims/:id/documents
      const mDoc = path.match(/^\/claims\/([^/]+)\/documents$/);
      if (mDoc) {
        const claimId    = mDoc[1];
        const c          = state.claims[claimId];
        if (!c) { const e = new Error('Not found'); e.response = { status: 404 }; return Promise.reject(e); }
        const documentId    = nextId('doc');
        const fileSizeBytes = data.file ? Buffer.from(data.file, 'base64').length : 0;
        c.events.push({ event_type: 'DOCUMENT_ATTACHED', documentId });
        return { data: { documentId, docType: data.docType, fileSizeBytes } };
      }

      // POST /claims/:id/diaries
      const mDiary = path.match(/^\/claims\/([^/]+)\/diaries$/);
      if (mDiary) {
        const claimId = mDiary[1];
        const c       = state.claims[claimId];
        if (!c) { const e = new Error('Not found'); e.response = { status: 404 }; return Promise.reject(e); }
        const diaryId = nextId('diy');
        c.diaries[diaryId] = { diaryId, status: 'open', dueDate: data.dueDate };
        c.events.push({ event_type: 'DIARY_CREATED', diaryId });
        return { data: { diaryId, status: 'open', dueDate: data.dueDate } };
      }

      // POST /claims/:id/payments
      const mPay = path.match(/^\/claims\/([^/]+)\/payments$/);
      if (mPay) {
        const claimId    = mPay[1];
        const c          = state.claims[claimId];
        if (!c) { const e = new Error('Not found'); e.response = { status: 404 }; return Promise.reject(e); }
        const paymentId   = nextId('pay');
        const checkNumber = `CHK-${String(state._id).padStart(6, '0')}`;
        c.payments.push({ paymentId, amount: data.amount });
        c.events.push({ event_type: 'PAYMENT_RECORDED', paymentId, amount: data.amount });
        return { data: { paymentId, checkNumber, amount: data.amount, status: 'issued' } };
      }

      return Promise.reject(new Error(`FH mock: unexpected POST ${path}`));
    },

    // ── GET ────────────────────────────────────────────────────────────────────
    get: async (path) => {
      // GET /claims/:id/ledger
      const mLedger = path.match(/^\/claims\/([^/]+)\/ledger$/);
      if (mLedger) {
        const claimId    = mLedger[1];
        const c          = state.claims[claimId];
        if (!c) { const e = new Error('Not found'); e.response = { status: 404 }; return Promise.reject(e); }
        const totalPaid    = c.payments.reduce((s, p) => s + p.amount, 0);
        const lastReserve  = c.reserves[c.reserves.length - 1];
        const totalReserve = lastReserve ? lastReserve.newTotal : 0;
        return { data: { claimId, events: c.events, totalPaid, totalReserve } };
      }

      return Promise.reject(new Error(`FH mock: unexpected GET ${path}`));
    },

    // ── PATCH ──────────────────────────────────────────────────────────────────
    patch: async (path, data) => {
      // PATCH /claims/:id/diaries/:diaryId
      const mPatch = path.match(/^\/claims\/([^/]+)\/diaries\/([^/]+)$/);
      if (mPatch) {
        const claimId  = mPatch[1];
        const diaryId  = mPatch[2];
        const c        = state.claims[claimId];
        if (!c) { const e = new Error('Not found'); e.response = { status: 404 }; return Promise.reject(e); }
        const diary = c.diaries[diaryId];
        if (!diary) { const e = new Error('Diary not found'); e.response = { status: 404 }; return Promise.reject(e); }
        diary.status = data.status;
        return { data: { diaryId, status: data.status } };
      }

      return Promise.reject(new Error(`FH mock: unexpected PATCH ${path}`));
    },
  };

  return {
    create:       jest.fn(() => client),
    delete:       jest.fn(() => Promise.resolve({ data: {} })),
    _resetState:  resetState,
  };
});

// ── Modules under test ────────────────────────────────────────────────────────
const axios = require('axios');
const fh    = require('../../src/services/filehandler');

// Replace the Python-server reset with the in-memory state reset
function resetMock() {
  axios._resetState();
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

// ═════════════════════════════════════════════════════════════════════════════
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

// ═════════════════════════════════════════════════════════════════════════════
describe('setReserves', () => {
  let fhClaimId;

  beforeEach(async () => {
    resetMock();
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

// ═════════════════════════════════════════════════════════════════════════════
describe('attachDocument', () => {
  let fhClaimId;

  beforeEach(async () => {
    resetMock();
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

// ═════════════════════════════════════════════════════════════════════════════
describe('createDiary / completeDiary', () => {
  let fhClaimId;

  beforeEach(async () => {
    resetMock();
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

// ═════════════════════════════════════════════════════════════════════════════
describe('recordPayment', () => {
  let fhClaimId;

  beforeEach(async () => {
    resetMock();
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

// ═════════════════════════════════════════════════════════════════════════════
describe('getLedger', () => {
  let fhClaimId;

  beforeEach(async () => {
    resetMock();
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
