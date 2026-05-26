'use strict';

/**
 * MockLegacyAdapter — full LegacyClaimsAdapter implementation backed by the
 * legacy_* tables provisioned in 20260102000015_legacy_integration.sql.
 *
 * Purpose: make the bidirectional integration story demonstrable in the
 * demo without depending on any third-party system. The adapter:
 *
 *   - ingests pre-seeded rows from legacy_claims and shapes them into
 *     ClaimLayer's canonical claim drafts
 *   - on write-back, appends rows to legacy_updates / legacy_diaries /
 *     legacy_documents so the reviewer can SEE what was pushed back via
 *     the GET /integrations/:system/legacy-record/:externalId endpoint
 *
 * Idempotency: ingestClaims excludes external_ids that already exist in
 * the claims table (so re-running migrate-from-legacy doesn't duplicate).
 */

const { LegacyClaimsAdapter } = require('./LegacyClaimsAdapter');
const { supabase } = require('../supabase');
const logger       = require('../../logger');

// Map legacy "status" strings to ClaimLayer canonical statuses. Anything
// not matched falls back to 'intake_complete' — see migration service.
const STATUS_MAP = {
  open:                'intake_complete',
  in_progress:         'active_medical',
  pending_review:      'under_investigation',
  closed:              'closed',
};

class MockLegacyAdapter extends LegacyClaimsAdapter {
  constructor() {
    super('mock_legacy');
  }

  async healthCheck() {
    const { data, error } = await supabase.from('legacy_claims').select('external_id');
    if (error) {
      return { ok: false, system: this.system, detail: error.message };
    }
    return {
      ok:          true,
      system:      this.system,
      detail:      'Backed by legacy_* tables',
      claim_count: (data || []).length,
    };
  }

  /**
   * Pull all legacy_claims that haven't been migrated yet (i.e. no claims
   * row with matching external_claim_id), and return them as canonical
   * drafts ready for legacyMigrationService to insert.
   */
  async ingestClaims(/* filter */) {
    const { data: legacyRows, error } = await supabase.from('legacy_claims').select('*');
    if (error) {
      logger.error({ msg: 'MockLegacyAdapter.ingestClaims: legacy_claims read failed', err: error.message });
      return [];
    }

    // De-dupe: pull existing external_claim_ids already migrated.
    const { data: existing } = await supabase
      .from('claims')
      .select('external_claim_id')
      .eq('source_system', this.system);
    const alreadyMigrated = new Set((existing || []).map(r => r.external_claim_id));

    const drafts = (legacyRows || [])
      .filter(r => !alreadyMigrated.has(r.external_id))
      .map(r => this._toCanonicalDraft(r));

    logger.info({
      msg:    'MockLegacyAdapter.ingestClaims',
      total:  (legacyRows || []).length,
      drafts: drafts.length,
      already_migrated: alreadyMigrated.size,
    });
    return drafts;
  }

  _toCanonicalDraft(row) {
    const raw = row.raw || {};
    const employee = raw.employee || {
      firstName: (row.claimant_name || '').split(' ')[0] || 'Unknown',
      lastName:  (row.claimant_name || '').split(' ').slice(1).join(' ') || 'Unknown',
      dob:       raw.dob || null,
      phone:     raw.phone || null,
      jobTitle:  raw.jobTitle || 'Home Health Worker',
      address:   raw.address || { line1: '1 Legacy St', state: 'CA', zip: '90001' },
    };
    return {
      external_claim_id: row.external_id,
      source_system:     this.system,
      employer_name:     row.employer_name,
      date_of_injury:    row.doi,
      body_part:         row.body_part,
      injury_type:       raw.injury_type || 'Lifting Injury',
      injury_description: raw.injury_description ||
        `Migrated from legacy system; original record id ${row.external_id}.`,
      status:            STATUS_MAP[row.status] || 'intake_complete',
      employee,
      aww:               raw.aww    || 750.75,
      td_rate:           raw.tdRate || 500.50,
      raw,
    };
  }

  async pushClaimUpdate(externalClaimId, { field, oldValue, newValue }) {
    const { data, error } = await supabase.from('legacy_updates').insert({
      external_claim_id: externalClaimId,
      field,
      old_value: oldValue == null ? null : String(oldValue),
      new_value: newValue == null ? null : String(newValue),
      pushed_at: new Date().toISOString(),
    });
    if (error) throw new Error(`legacy_updates insert failed: ${error.message}`);
    return { ok: true, system: this.system, row: Array.isArray(data) ? data[0] : data };
  }

  async pushDiary(externalClaimId, diary) {
    const { data, error } = await supabase.from('legacy_diaries').insert({
      external_claim_id: externalClaimId,
      type:              diary.type,
      due_date:          diary.dueDate,
      notes:             diary.notes,
      pushed_at:         new Date().toISOString(),
    });
    if (error) throw new Error(`legacy_diaries insert failed: ${error.message}`);
    return { ok: true, system: this.system, row: Array.isArray(data) ? data[0] : data };
  }

  async pushDocument(externalClaimId, document) {
    const { data, error } = await supabase.from('legacy_documents').insert({
      external_claim_id: externalClaimId,
      doc_type:          document.docType,
      title:             document.title,
      summary:           document.summary,
      pushed_at:         new Date().toISOString(),
    });
    if (error) throw new Error(`legacy_documents insert failed: ${error.message}`);
    return { ok: true, system: this.system, row: Array.isArray(data) ? data[0] : data };
  }

  async pushNotice(externalClaimId, notice) {
    // Notices land in legacy_documents with a NOTICE_* docType — keeps the
    // legacy side's document index single-table while still distinguishable
    // from arbitrary uploads.
    return this.pushDocument(externalClaimId, {
      docType: `NOTICE_${(notice.noticeType || 'GENERIC').toUpperCase()}`,
      title:   notice.title,
      summary: notice.summary,
    });
  }
}

module.exports = MockLegacyAdapter;
