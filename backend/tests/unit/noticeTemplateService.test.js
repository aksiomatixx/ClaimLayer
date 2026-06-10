'use strict';

/**
 * Unit tests — Notice Generation Library.
 *
 * Registry completeness (the 20 master-context templates), uniform
 * generation (PDF document + tracking rows), attorney copies for
 * represented workers, deadline computation, and the Spanish
 * blocked-pending-translation guardrail (no synthesized translations).
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/noticeTemplateService');

const CLAIM = 'claim_notice_test';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-N-1', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1',
    td_rate: 500, attorney_represented: false,
    employee: { firstName: 'Test', lastName: 'Worker', address: { line1: '1 Main St', zip: '90001' } },
  });
});

describe('registry completeness', () => {
  const WORKER_TYPES = [
    'claim_accepted', 'claim_denied', 'td_commencement', 'td_rate_change',
    'td_suspension', 'td_reinstatement', 'td_termination', 'pd_commencement',
    'pd_rate_change', 'pd_suspension', 'pd_resumption', 'ps_mmi_rating',
    'settlement_offer', 'ur_decision', 'qme_process', 'mpn_enrollment',
  ];
  const PROVIDER_TYPES = [
    'ptp_authorization', 'ptp_change', 'specialist_authorization', 'ur_decision_provider',
  ];

  it('contains exactly the 20 master-context templates', () => {
    expect(Object.keys(svc.NOTICE_TEMPLATES).sort())
      .toEqual([...WORKER_TYPES, ...PROVIDER_TYPES].sort());
  });

  it.each(WORKER_TYPES)('%s is worker-facing with a regulatory cite', (t) => {
    expect(svc.NOTICE_TEMPLATES[t].audience).toBe('worker');
    expect(svc.NOTICE_TEMPLATES[t].cite).toMatch(/§/);
    expect(typeof svc.NOTICE_TEMPLATES[t].body).toBe('function');
  });

  it.each(PROVIDER_TYPES)('%s is provider-facing with a regulatory cite', (t) => {
    expect(svc.NOTICE_TEMPLATES[t].audience).toBe('provider');
    expect(svc.NOTICE_TEMPLATES[t].cite).toMatch(/§/);
  });

  it('the five M9 bespoke generators are cross-referenced', () => {
    expect(svc.NOTICE_TEMPLATES.claim_denied.bespoke).toContain('generateDenialNotice');
    expect(svc.NOTICE_TEMPLATES.td_commencement.bespoke).toContain('generateTdNotice');
    expect(svc.NOTICE_TEMPLATES.ur_decision.bespoke).toContain('generateRfaLetter');
  });
});

describe('generateNotice — uniform path', () => {
  it('renders a DRAFT-bannered PDF, files it, and creates a tracking row with the deadline', async () => {
    const { notices, document } = await svc.generateNotice('td_suspension', CLAIM, {
      effective_date: '2026-06-15', reason: 'returned to full duty', event_date: '2026-06-10',
    });

    expect(notices).toHaveLength(1);
    const n = notices[0];
    expect(n.audience).toBe('worker');
    expect(n.language).toBe('en');
    expect(n.status).toBe('generated');
    expect(n.regulatory_cite).toContain('9812');
    expect(n.deadline_basis).toBe('calendar_days_14');
    expect(n.due_date).toBe('2026-06-24');
    expect(n.document_id).toBe(document.id);

    // PDF really rendered and filed as a claim document
    expect(document.category).toBe('correspondence');
    expect(document.source).toBe('system_generated');
    const pdf = Buffer.from(document.pdf_buffer_b64, 'base64');
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'notice_generated')).toBe(true);
  });

  it('adds an attorney copy when the worker is represented', async () => {
    await supabase.from('claims').update({
      attorney_represented: true, attorney_name: 'L. Counsel', attorney_firm: 'Counsel LLP',
    }).eq('id', CLAIM);

    const { notices } = await svc.generateNotice('claim_accepted', CLAIM, {});
    expect(notices.map(n => n.audience).sort()).toEqual(['attorney', 'worker']);
    const atty = notices.find(n => n.audience === 'attorney');
    expect(atty.recipient.name).toBe('L. Counsel');
    expect(atty.document_id).toBeTruthy();
  });

  it('provider notices address the provider, never the worker', async () => {
    const { notices } = await svc.generateNotice('ptp_authorization', CLAIM, {
      provider: { name: 'Dr. A. Demo', npi: '1234567890' },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].audience).toBe('provider');
    expect(notices[0].recipient.name).toBe('Dr. A. Demo');
  });

  it('business-day deadlines use the CA business-day calendar', async () => {
    // 2026-06-12 is a Friday; +2 business days = Tuesday 2026-06-16.
    const { notices } = await svc.generateNotice('ur_decision', CLAIM, {
      decision: 'approved', rfa_date: '2026-06-10', event_date: '2026-06-12',
    });
    expect(notices[0].deadline_basis).toBe('business_days_2');
    expect(notices[0].due_date).toBe('2026-06-16');
  });

  it('throws on unknown notice types with the valid list', async () => {
    await expect(svc.generateNotice('not_a_notice', CLAIM, {}))
      .rejects.toThrow(/Unknown notice type/);
  });
});

describe('Spanish — never synthesized', () => {
  it("requesting Spanish creates a blocked_pending_translation row with no document", async () => {
    const { notices } = await svc.generateNotice('claim_accepted', CLAIM, {}, { includeSpanish: true });

    const en = notices.find(n => n.language === 'en');
    const es = notices.find(n => n.language === 'es');
    expect(en.status).toBe('generated');
    expect(es.status).toBe('blocked_pending_translation');
    expect(es.document_id).toBeNull();
  });
});

describe('listNotices', () => {
  it('returns the claim ledger newest first', async () => {
    await svc.generateNotice('claim_accepted', CLAIM, {});
    await svc.generateNotice('td_commencement', CLAIM, { weekly_rate: 500 });
    const list = await svc.listNotices(CLAIM);
    expect(list).toHaveLength(2);
    expect(list[0].notice_type).toBe('td_commencement');
  });
});
