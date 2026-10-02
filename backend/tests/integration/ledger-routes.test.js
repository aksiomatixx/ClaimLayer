'use strict';

/**
 * Integration tests — the ledger, escrow and staffing routes added outside the
 * PR flow, after review:
 *   - a payment requested from the claim ledger is a payment.issue proposal,
 *     issued only when a second human with authority (and MFA) approves it;
 *   - the tenant, actor and claim come from the session and the path, never
 *     from the request body;
 *   - employer-portal users are kept out of other employers' data;
 *   - a stored document that fails its integrity check is not served.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');
jest.mock('../../src/services/filehandler', () => ({
  createClaim: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(), addNote: jest.fn(),
  setReserves: jest.fn().mockResolvedValue({ ok: true }),
}));

const request       = require('supertest');
const app           = require('../../src/index');
const claimService  = require('../../src/services/claimService');
const reserveLedger = require('../../src/services/reserveLedgerService');
const { supabase }  = require('../../src/services/supabase');
const { generateStaffToken, generateEmployerToken } = require('../../src/middleware/auth');

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER  = '00000000-0000-0000-0000-0000000000b2';
const CLAIM  = 'claim_lr_1';
const token  = (role, email, extra = {}) => `Bearer ${generateStaffToken({ role, sub: email, email, mfa: true, ...extra })}`;
// Claim-scoped write routes admit the 'admin' (desk adjuster) role; supervisors approve.
const ADJ    = token('admin', 'adj1@tpa.test');
const SUP    = token('supervisor', 'sup@tpa.test');
const EMPLOYER = `token=${generateEmployerToken({ sub: 'emp-user', email: 'hr@x.test', employerId: 'e0000000-0000-0000-0000-000000000001' })}`;

beforeEach(async () => {
  supabase._resetStore();
  claimService._resetClaims();
  claimService._seedClaim({
    id: CLAIM, claimNumber: 'CL-2026-LR1', status: 'accepted', employerId: 'e0000000-0000-0000-0000-000000000001',
    dateOfInjury: '2026-05-01', filehandlerId: 'fh_lr_1', employee: {}, events: [], diaries: [],
  });
  await reserveLedger.postTransaction({ tenantId: TENANT, claimId: CLAIM, category: 'indemnity', amountDelta: 5000, transactionType: 'initial_reserve' });
});

const payments = async () => (await supabase.from('payment_transactions').select('*').eq('claim_id', CLAIM)).data || [];

describe('POST /claims/:id/ledger/payments', () => {
  const body = { amount: 1200, category: 'indemnity', paymentType: 'td_temporary_disability',
    periodStart: '2026-05-01', periodEnd: '2026-05-14', rationale: 'TD for the first two weeks per PR-2.' };

  test('proposes a payment.issue request (202) and issues nothing', async () => {
    const res = await request(app).post(`/api/v1/claims/${CLAIM}/ledger/payments`).set('Authorization', ADJ).send(body);
    expect(res.status).toBe(202);
    expect(res.body.request).toMatchObject({
      action_type: 'payment.issue', status: 'pending_approval', proposed_by: 'adj1@tpa.test', amount_cents: 120000,
    });
    expect(await payments()).toEqual([]);
  });

  test('the payment is issued when a second human approves it, attributed to the approver', async () => {
    const proposed = await request(app).post(`/api/v1/claims/${CLAIM}/ledger/payments`).set('Authorization', ADJ).send(body);
    const decided = await request(app).post(`/api/v1/action-requests/${proposed.body.request.id}/decision`)
      .set('Authorization', SUP).send({ decision: 'approve', rationale: 'Verified against the PR-2 and wage statement.' });
    expect(decided.status).toBe(200);
    expect(decided.body.request.status).toBe('executed');

    const [row] = await payments();
    expect(row).toMatchObject({ amount: 1200, status: 'issued', created_by: 'sup@tpa.test', action_request_id: proposed.body.request.id });
    const balances = await reserveLedger.getBalances(CLAIM);
    expect(balances.categories.indemnity).toMatchObject({ outstanding: 3800, paid_to_date: 1200 });
  });

  test('the proposer cannot approve their own payment request', async () => {
    const proposed = await request(app).post(`/api/v1/claims/${CLAIM}/ledger/payments`).set('Authorization', ADJ).send(body);
    const decided = await request(app).post(`/api/v1/action-requests/${proposed.body.request.id}/decision`)
      .set('Authorization', ADJ).send({ decision: 'approve', rationale: 'Approving my own request.' });
    expect(decided.status).toBeGreaterThanOrEqual(400);
    expect(await payments()).toEqual([]);
  });

  test('an unknown payment type is refused at proposal', async () => {
    const res = await request(app).post(`/api/v1/claims/${CLAIM}/ledger/payments`).set('Authorization', ADJ)
      .send({ ...body, paymentType: 'bonus' });
    expect(res.status).toBe(400);
  });
});

describe('the session, not the body, decides tenant, actor and claim', () => {
  test('a loss-fund account is created in the caller\'s tenant whatever the body says', async () => {
    const res = await request(app).post('/api/v1/financials/loss-funds').set('Authorization', SUP)
      .send({ employerId: 'e0000000-0000-0000-0000-000000000001', accountNumber: 'ESC-9', tenantId: OTHER, actor: { id: 'mallory' } });
    expect(res.status).toBe(201);
    expect(res.body.loss_fund_account.tenant_id).toBe(TENANT);
    const { data } = await supabase.from('audit_ledger').select('*').eq('action', 'loss_fund.account_created');
    expect(data[0].actor_id).toBe('sup@tpa.test');
  });

  test('a body part is added to the claim in the path, not one named in the body', async () => {
    const res = await request(app).post(`/api/v1/staffing/claims/${CLAIM}/body-parts`).set('Authorization', ADJ)
      .send({ bodyPartCode: '42', bodyPartName: 'Lumbar', claimId: 'someone_elses_claim', tenantId: OTHER });
    expect(res.status).toBe(201);
    expect(res.body.body_part).toMatchObject({ claim_id: CLAIM, tenant_id: TENANT });
  });

  test('a body part on a claim outside the caller\'s scope is refused', async () => {
    claimService._seedClaim({ id: 'claim_lr_other', claimNumber: 'CL-OTHER', status: 'accepted', tenantId: OTHER,
      employerId: 'emp-x', dateOfInjury: '2026-05-01', employee: {}, events: [], diaries: [] });
    const res = await request(app).post('/api/v1/staffing/claims/claim_lr_other/body-parts').set('Authorization', ADJ)
      .send({ bodyPartCode: '42', bodyPartName: 'Lumbar' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('employer-portal users', () => {
  test('see only their own employer\'s loss fund', async () => {
    const res = await request(app).get('/api/v1/financials/loss-funds/e0000000-0000-0000-0000-000000000002')
      .set('Cookie', EMPLOYER);
    expect(res.status).toBe(404);
  });

  test('have no access to the staffing hierarchy or client loss runs', async () => {
    for (const path of ['/api/v1/staffing/agencies', '/api/v1/staffing/host-employers', '/api/v1/staffing/host-employers/x/loss-run']) {
      const res = await request(app).get(path).set('Cookie', EMPLOYER);
      expect(res.status).toBe(403);
    }
  });
});

describe('document integrity', () => {
  test('a stored original that fails its SHA-256 check is not served (409), with no fallback', async () => {
    await supabase.from('claim_documents').insert({
      id: 'doc_lr_1', claim_id: CLAIM, doc_type: 'PR2', title: 'PR-2',
      pdf_buffer_b64: Buffer.from('%PDF-1.4 tampered').toString('base64'),
      sha256_checksum: 'a'.repeat(64), storage_provider: 'inline',
    });
    const res = await request(app).get(`/api/v1/claims/${CLAIM}/documents/doc_lr_1/file`).set('Authorization', SUP);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_INTEGRITY_FAILURE');
  });
});
