'use strict';

/**
 * Additional integrity hardening:
 *   - claim creation checks Supabase results BEFORE any external side
 *     effect (no FileHandler claim without a local row behind it)
 *   - AI decision audit persistence is REQUIRED for regulated
 *     decisions — an audit failure fails the operation
 *   - magic-link validation enforces token purpose, requires jti,
 *     binds to the persisted claim/employee, honors persistent expiry,
 *     and is atomically single-use
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockFhCreateClaim = jest.fn();
jest.mock('../../src/services/filehandler', () => ({
  createClaim: (...a) => mockFhCreateClaim(...a),
  setReserves: jest.fn().mockResolvedValue({}),
  addNote: jest.fn().mockResolvedValue({}),
  completeDiary: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({
    associateOID: 'oid-1', firstName: 'Integ', lastName: 'Rity', dob: '1990-01-01',
    address: { line1: 'x', state: 'CA', zip: '90057' }, phone: '555',
    jobTitle: 'HHA', hireDate: '2024-01-01', aww: 900, tdRate: 600, weeksCalculated: 52,
  }),
}));
jest.mock('../../src/services/noticeService', () => ({
  generateDwc7: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/services/wcisTriggerService', () => ({
  enqueueIfReportable: jest.fn().mockResolvedValue({}),
}));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/index');
const config = require('../../src/config');
const { supabase } = require('../../src/services/supabase');
const db = require('../../src/services/db');
const { generateMagicToken } = require('../../src/middleware/auth');
const claimService = require('../../src/services/claimService');

const flush = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

beforeEach(() => {
  supabase._resetStore();
  claimService._resetClaims();
  mockFhCreateClaim.mockReset().mockResolvedValue({ claimId: 'FH-INT', status: 'open' });
  mockMessagesCreate.mockReset().mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({
      category: 'work_status', confidence: 90, claim_number: null,
      summary: 'x', key_fields: { signals: [] },
    }) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
});

function injectTableFailure(table, op = 'insert') {
  const realFrom = supabase.from.bind(supabase);
  let armed = true;
  const spy = jest.spyOn(supabase, 'from').mockImplementation((t) => {
    const builder = realFrom(t);
    if (t === table && armed) {
      const real = builder[op].bind(builder);
      builder[op] = (...args) => {
        armed = false;
        const failed = Promise.resolve({ data: null, error: { message: `injected ${table} outage` } });
        return {
          then: failed.then.bind(failed),
          select: () => ({ single: () => failed, then: failed.then.bind(failed) }),
          eq: () => ({ select: () => failed, then: failed.then.bind(failed) }),
          _real: real, ...{},
        };
      };
    }
    return builder;
  });
  return spy;
}

const FROI = {
  adpEmployeeId: 'ADP-INT-1', employerName: 'Test Co',
  dateOfInjury: '2026-05-01', injuryDescription: 'Integrity test injury description.',
};

describe('claim creation checks local persistence before external effects', () => {
  it('a claims-insert failure aborts BEFORE FileHandler is called', async () => {
    const spy = injectTableFailure('claims');
    try {
      await expect(claimService.createClaim(FROI, 'emp-1'))
        .rejects.toThrow(/claim insert failed.*injected claims outage/);
      expect(mockFhCreateClaim).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await flush();
    }
  });

  it('an initial-events failure compensates the claim row and never reaches FileHandler', async () => {
    const spy = injectTableFailure('claim_events');
    try {
      await expect(claimService.createClaim(FROI, 'emp-1'))
        .rejects.toThrow(/initial events insert failed/);
      expect(mockFhCreateClaim).not.toHaveBeenCalled();
      const { data: claims } = await supabase.from('claims').select('*');
      expect(claims).toHaveLength(0); // no half-created claim
    } finally {
      spy.mockRestore();
      await flush();
    }
  });
});

describe('AI decision audit persistence is required for regulated decisions', () => {
  it('a doc-classification audit failure fails the classification (no unaudited decision)', async () => {
    const aiService = require('../../src/services/aiService');
    const spy = injectTableFailure('ai_decisions');
    try {
      await expect(aiService.classifyDocument({ text: 'work status report', filename: 'w.pdf' }))
        .rejects.toThrow(/audit persistence failed for doc_classification/);
    } finally {
      spy.mockRestore();
    }
  });

  it('an audit failure during ingestion means no document is silently filed', async () => {
    const ingestion = require('../../src/services/documentIngestionService');
    const spy = injectTableFailure('ai_decisions');
    try {
      await expect(ingestion.ingestDocument({ title: 'x', content_text: 'work status' }, 'a'))
        .rejects.toThrow(/audit persistence failed/);
      const { data: docs } = await supabase.from('claim_documents').select('*');
      expect(docs).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('magic-link validation', () => {
  const CLAIM = 'claim_magic_1';

  async function seedLink({ jti = `jti_${Math.random().toString(36).slice(2)}`, expiresInMs = 72 * 3600 * 1000, rowOverrides = {} } = {}) {
    claimService._seedClaim({
      id: CLAIM, claimNumber: 'HHW-MAGIC-1', employerId: 'employer-brightcare-001',
      status: 'new_claim', employee: { adpEmployeeId: 'ADP-M-1' },
      dateOfInjury: '2026-05-01', events: [],
    });
    await db.magicLinkTokens.create({
      jti, claim_id: CLAIM, adp_employee_id: 'ADP-M-1',
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      ...rowOverrides,
    });
    const token = generateMagicToken({ claimId: CLAIM, adpEmployeeId: 'ADP-M-1', jti });
    return { token, jti };
  }

  const validate = (token) =>
    request(app).post('/api/v1/auth/magic-link/validate').send({ token });

  it('a valid link validates once and issues a purpose-scoped session', async () => {
    const { token } = await seedLink();
    const res = await validate(token);
    expect(res.status).toBe(200);
    expect(res.body.session_token).toBeTruthy();
    const session = jwt.verify(res.body.session_token, config.jwtSecret);
    expect(session.purpose).toBe('employee_session');
    expect(session.claimId).toBe(CLAIM);
  });

  it('a second use is rejected: single use is atomic and persistent', async () => {
    const { token } = await seedLink();
    expect((await validate(token)).status).toBe(200);
    const again = await validate(token);
    expect(again.status).toBe(410);
    expect(again.body.error).toBe('link_already_used');
  });

  it('two CONCURRENT validations: exactly one wins', async () => {
    const { token } = await seedLink();
    const [a, b] = await Promise.all([validate(token), validate(token)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 410]);
  });

  it('a session token cannot be replayed to mint another session (purpose enforcement)', async () => {
    const { token } = await seedLink();
    const first = await validate(token);
    const sessionToken = first.body.session_token;

    const replay = await validate(sessionToken);
    expect(replay.status).toBe(401);
  });

  it('tokens without a jti are rejected — single use cannot be bypassed', async () => {
    await seedLink();
    const noJti = generateMagicToken({ claimId: CLAIM, adpEmployeeId: 'ADP-M-1' });
    const res = await validate(noJti);
    expect(res.status).toBe(401);
  });

  it('the token must bind to the persisted claim + employee', async () => {
    const { jti } = await seedLink();
    // Forge a token reusing a real jti but pointing at a different claim.
    const forged = generateMagicToken({ claimId: 'claim_other', adpEmployeeId: 'ADP-M-1', jti });
    const res = await validate(forged);
    expect(res.status).toBe(401);

    // The row was NOT consumed by the failed attempt.
    const record = await db.magicLinkTokens.findByJti(jti);
    expect(record.used_at).toBeNull();
  });

  it('expiry is enforced from persistent storage, not just the JWT', async () => {
    const { token } = await seedLink({ expiresInMs: -60_000 }); // row already expired
    const res = await validate(token); // JWT itself is still within 72h
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('link_expired');
  });
});
