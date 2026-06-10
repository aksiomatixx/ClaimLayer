'use strict';

/**
 * Reserve approval boundary (Finding 2 of the production-hardening pass).
 *
 * AI analysis may store reserve recommendations locally only. The
 * FileHandler setReserves call — the external financial mutation — must
 * not happen until an authenticated adjuster approves through the
 * reserve approval endpoint. The lifecycle is:
 *
 *   suggested  — ai_analysis.suggested* + reserves_suggested event
 *   pending    — suggestion exists, no approved reserves row yet
 *   approved   — reserves row (source ADJUSTER) + reserves_approved
 *                event + the one-and-only setReserves call
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockSetReserves = jest.fn().mockResolvedValue({ status: 'ok' });
jest.mock('../../src/services/filehandler', () => ({
  setReserves:    (...a) => mockSetReserves(...a),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'FH-RES', status: 'open' }),
  addNote:        jest.fn().mockResolvedValue({}),
  completeDiary:  jest.fn().mockResolvedValue({}),
  attachDocument: jest.fn().mockResolvedValue({}),
}));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const request = require('supertest');
const app = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');
const claimService = require('../../src/services/claimService');

const ADMIN = `Bearer ${generateAdminToken({ sub: 'adm', email: 'adjuster@test' })}`;
const CLAIM = 'claim_reserves_1';

const ANALYSIS = {
  compensability: 'likely_compensable',
  compensabilityScore: 82,
  priority: 'standard',
  suggestedMedicalReserve: 25000,
  suggestedIndemnityReserve: 18000,
  suggestedExpenseReserve: 4500,
  redFlags: [],
  nextActions: [],
  rationale: 'test',
};

beforeEach(async () => {
  mockSetReserves.mockClear();
  mockMessagesCreate.mockReset();
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(ANALYSIS) }],
    usage: { input_tokens: 500, output_tokens: 200 },
  });
  supabase._resetStore();
  claimService._resetClaims();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-2026-RES', status: 'new_claim',
    date_of_injury: '2026-05-01', employer_id: 'emp-1',
    filehandler_id: 'FH-RES', injury_type: 'Lifting Injury',
    employee: { firstName: 'Res', lastName: 'Erve', jobTitle: 'HHA' },
    aww: 900, td_rate: 600,
  });
});

describe('AI analysis must not mutate external reserves', () => {
  it('analysis stores the suggestion locally and never calls setReserves', async () => {
    const res = await request(app)
      .post(`/api/v1/claims/${CLAIM}/analyze`).set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.aiAnalysis.suggestedMedicalReserve).toBe(25000);

    // THE invariant: no external financial mutation from AI analysis.
    expect(mockSetReserves).not.toHaveBeenCalled();

    // The suggestion is documented locally in the suggested state.
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const suggested = events.find(e => e.type === 'reserves_suggested');
    expect(suggested).toBeTruthy();
    expect(suggested.data.status).toBe('suggested_pending_adjuster_approval');
    expect(suggested.data.source).toBe('AI_ENGINE');
    expect(events.some(e => e.type === 'reserves_set')).toBe(false);

    // Nothing in the approved reserves ledger yet — the pending state.
    const { data: reserveRows } = await supabase.from('reserves').select('*').eq('claim_id', CLAIM);
    expect(reserveRows).toHaveLength(0);
  });

  it('adjuster approval is the only path to the external write', async () => {
    await request(app).post(`/api/v1/claims/${CLAIM}/analyze`).set('Authorization', ADMIN);
    expect(mockSetReserves).not.toHaveBeenCalled();

    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM}/reserves`).set('Authorization', ADMIN)
      .send({ medical: 26000, indemnity: 18000, expense: 5000, reason: 'Initial reserves per AI suggestion, medical adjusted' });
    expect(res.status).toBe(200);

    expect(mockSetReserves).toHaveBeenCalledTimes(1);
    const [fhId, payload, setBy] = mockSetReserves.mock.calls[0];
    expect(fhId).toBe('FH-RES');
    expect(payload.medical).toBe(26000);
    expect(setBy).toBe('ADJUSTER');

    const { data: reserveRows } = await supabase.from('reserves').select('*').eq('claim_id', CLAIM);
    expect(reserveRows).toHaveLength(1);
    expect(reserveRows[0].source).toBe('ADJUSTER');
    expect(reserveRows[0].approved_by).toBeTruthy();

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'reserves_approved')).toBe(true);
  });

  it('reserve approval requires the admin role', async () => {
    const { generateMagicToken } = require('../../src/middleware/auth');
    const emp = `Bearer ${generateMagicToken({ sub: 'e', claimId: CLAIM })}`;
    const res = await request(app)
      .patch(`/api/v1/claims/${CLAIM}/reserves`).set('Authorization', emp)
      .send({ medical: 1, indemnity: 1, expense: 1 });
    expect(res.status).toBe(403);
    expect(mockSetReserves).not.toHaveBeenCalled();
  });
});
