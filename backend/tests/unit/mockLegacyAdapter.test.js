'use strict';

/**
 * Unit tests for MockLegacyAdapter.
 *
 * Backed by the in-memory supabase mock — no real database required.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const MockLegacyAdapter = require('../../src/services/legacy/MockLegacyAdapter');

describe('MockLegacyAdapter', () => {
  let adapter;

  beforeEach(() => {
    supabase._resetStore();
    adapter = new MockLegacyAdapter();
  });

  // ── healthCheck ────────────────────────────────────────────────────────────
  describe('healthCheck', () => {
    it('returns ok=true and a claim count', async () => {
      await supabase.from('legacy_claims').insert({
        external_id: 'LEG-X1', claimant_name: 'Test', doi: '2026-01-15',
      });
      const h = await adapter.healthCheck();
      expect(h.ok).toBe(true);
      expect(h.system).toBe('mock_legacy');
      expect(h.claim_count).toBe(1);
    });

    it('reports zero when no legacy claims exist', async () => {
      const h = await adapter.healthCheck();
      expect(h.ok).toBe(true);
      expect(h.claim_count).toBe(0);
    });
  });

  // ── ingestClaims ───────────────────────────────────────────────────────────
  describe('ingestClaims', () => {
    beforeEach(async () => {
      await supabase.from('legacy_claims').insert({
        external_id: 'LEG-A', claimant_name: 'Alice Sun',
        employer_name: 'Westside HCS', doi: '2026-03-01',
        body_part: 'Shoulder', status: 'open',
        raw: { injury_type: 'Strain / Sprain', aww: 700, tdRate: 466.67 },
      });
      await supabase.from('legacy_claims').insert({
        external_id: 'LEG-B', claimant_name: 'Bob Lin',
        employer_name: 'BrightCare HH', doi: '2026-02-10',
        body_part: 'Lumbar Spine / Lower Back', status: 'in_progress',
        raw: { injury_type: 'Lifting Injury' },
      });
    });

    it('maps legacy schema → canonical claim drafts', async () => {
      const drafts = await adapter.ingestClaims();
      expect(drafts).toHaveLength(2);
      const a = drafts.find(d => d.external_claim_id === 'LEG-A');
      expect(a.source_system).toBe('mock_legacy');
      expect(a.employer_name).toBe('Westside HCS');
      expect(a.body_part).toBe('Shoulder');
      expect(a.injury_type).toBe('Strain / Sprain');
      expect(a.aww).toBe(700);
      expect(a.td_rate).toBe(466.67);
      expect(a.employee.firstName).toBe('Alice');
      expect(a.employee.lastName).toBe('Sun');
      expect(a.status).toBe('intake_complete'); // open → intake_complete
    });

    it('maps legacy status strings to canonical statuses', async () => {
      const drafts = await adapter.ingestClaims();
      const b = drafts.find(d => d.external_claim_id === 'LEG-B');
      expect(b.status).toBe('active_medical'); // in_progress → active_medical
    });

    it('skips claims already migrated', async () => {
      await supabase.from('claims').insert({
        id: 'claim_legacy_LEG-A',
        source_system: 'mock_legacy', external_claim_id: 'LEG-A',
      });
      const drafts = await adapter.ingestClaims();
      expect(drafts).toHaveLength(1);
      expect(drafts[0].external_claim_id).toBe('LEG-B');
    });
  });

  // ── push* methods ──────────────────────────────────────────────────────────
  describe('write-back', () => {
    it('pushClaimUpdate writes a legacy_updates row', async () => {
      const out = await adapter.pushClaimUpdate('LEG-Z', {
        field: 'status', oldValue: 'open', newValue: 'in_progress',
      });
      expect(out.ok).toBe(true);
      const { data: rows } = await supabase.from('legacy_updates').select('*').eq('external_claim_id', 'LEG-Z');
      expect(rows).toHaveLength(1);
      expect(rows[0].field).toBe('status');
      expect(rows[0].old_value).toBe('open');
      expect(rows[0].new_value).toBe('in_progress');
      expect(rows[0].pushed_at).toBeTruthy();
    });

    it('pushDiary writes a legacy_diaries row', async () => {
      await adapter.pushDiary('LEG-Z', {
        type: 'PR2_FOLLOW_UP', dueDate: '2026-06-01',
        notes: 'Follow up on PR-2',
      });
      const { data: rows } = await supabase.from('legacy_diaries').select('*').eq('external_claim_id', 'LEG-Z');
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('PR2_FOLLOW_UP');
      expect(rows[0].due_date).toBe('2026-06-01');
      expect(rows[0].notes).toBe('Follow up on PR-2');
    });

    it('pushDocument writes a legacy_documents row', async () => {
      await adapter.pushDocument('LEG-Z', {
        docType: 'PR2', title: 'PR-2 report', summary: 'Treating physician progress report',
      });
      const { data: rows } = await supabase.from('legacy_documents').select('*').eq('external_claim_id', 'LEG-Z');
      expect(rows).toHaveLength(1);
      expect(rows[0].doc_type).toBe('PR2');
      expect(rows[0].title).toBe('PR-2 report');
    });

    it('pushNotice writes a legacy_documents row with NOTICE_ docType', async () => {
      await adapter.pushNotice('LEG-Z', {
        noticeType: 'dwc7', title: 'DWC-7 Notice', summary: 'Notice of rights',
      });
      const { data: rows } = await supabase.from('legacy_documents').select('*').eq('external_claim_id', 'LEG-Z');
      expect(rows).toHaveLength(1);
      expect(rows[0].doc_type).toBe('NOTICE_DWC7');
    });
  });

  // ── system identifier ──────────────────────────────────────────────────────
  it('reports system="mock_legacy"', () => {
    expect(adapter.system).toBe('mock_legacy');
  });
});
