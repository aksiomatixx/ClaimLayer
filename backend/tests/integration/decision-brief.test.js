'use strict';

/**
 * Integration tests — claim documents + decision brief endpoints:
 *   GET /api/v1/claims/:id/documents
 *   GET /api/v1/claims/:id/documents/:docId/file
 *   GET /api/v1/claims/:id/decision-brief
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });
const auth = (r) => r.set('Cookie', `token=${adminToken}`);

const CLAIM_ID = 'claim_brief_test';

async function seed() {
  await supabase.from('claims').insert({
    id: CLAIM_ID, claim_number: 'HHW-TEST-90', status: 'under_investigation',
    date_of_injury: '2026-05-01', body_part: 'Knee', injury_type: 'Slip & Fall',
    employee: { firstName: 'Rosa', lastName: 'Mendez', adpEmployeeId: 'X1' },
    aww: 750, td_rate: 500, employer_id: 'employer-test',
    ai_analysis: { compensability: 'Likely Compensable', compensabilityScore: 82, priority: 'High' },
    created_at: new Date().toISOString(),
  });
  await supabase.from('diaries').insert({
    id: 'diy_test_comp', claim_id: CLAIM_ID, diary_type: 'COMPENSABILITY_DECISION_DUE',
    due_date: '2026-07-15', priority: 'CRITICAL', status: 'open', notes: 'LC §5402',
    fh_diary_id: 'fhd_mirror_99', // regression: brief must carry OUR id, not the mirror's
  });
  await supabase.from('claim_documents').insert({
    id: 'doc_test_pr1', claim_id: CLAIM_ID, title: 'Initial treating physician report (PR-1)',
    category: 'medical_report', source: 'provider', received_at: '2026-05-04T00:00:00Z',
    pages: 6, ai_summary: 'Dx lumbar strain; restrictions 2 weeks.',
    relevant_to: ['COMPENSABILITY_DECISION_DUE'], status: 'filed',
  });
  await supabase.from('claim_documents').insert({
    id: 'doc_test_wage', claim_id: CLAIM_ID, title: 'Wage statement',
    category: 'wage_statement', source: 'employer', received_at: '2026-05-02T00:00:00Z',
    pages: 2, ai_summary: 'Supports AWW.', relevant_to: [], status: 'filed',
  });
}

beforeEach(async () => { supabase._resetStore(); await seed(); });

describe('GET /api/v1/claims/:id/documents', () => {
  it('returns documents newest-first with AI summaries', async () => {
    const res = await auth(request(app).get(`/api/v1/claims/${CLAIM_ID}/documents`));
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
    expect(res.body.documents[0].id).toBe('doc_test_pr1'); // newer first
    expect(res.body.documents[0].ai_summary).toContain('lumbar strain');
  });

  it('requires admin role', async () => {
    const res = await request(app).get(`/api/v1/claims/${CLAIM_ID}/documents`);
    expect([401, 403]).toContain(res.status);
  });
});

describe('GET /api/v1/claims/:id/documents/:docId/file', () => {
  it('returns a PDF for the original-document link', async () => {
    const res = await auth(request(app).get(`/api/v1/claims/${CLAIM_ID}/documents/doc_test_pr1/file`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('404s when the document belongs to another claim', async () => {
    const res = await auth(request(app).get(`/api/v1/claims/other_claim/documents/doc_test_pr1/file`));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/claims/:id/decision-brief', () => {
  it('returns plain-language summary, contract, and actions with linked documents', async () => {
    const res = await auth(request(app).get(`/api/v1/claims/${CLAIM_ID}/decision-brief`));
    expect(res.status).toBe(200);
    expect(res.body.summary).toContain('Rosa Mendez');
    expect(res.body.summary).toContain('under investigation');
    expect(res.body.contract).toMatch(/timelines are met/i);
    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0].action).toMatch(/compensability/i);
    expect(res.body.actions[0].why).toContain('LC §5402');
    expect(res.body.actions[0].document_ids).toEqual(['doc_test_pr1']);
    // the action must be drivable: diary_id is the local diaries.id, never
    // the FileHandler mirror id
    expect(res.body.actions[0].diary_id).toBe('diy_test_comp');
  });

  it('404s for an unknown claim', async () => {
    const res = await auth(request(app).get('/api/v1/claims/nope/decision-brief'));
    expect(res.status).toBe(404);
  });
});
