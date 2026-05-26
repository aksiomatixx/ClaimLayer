'use strict';

/**
 * legacyMigrationService — pulls canonical claim drafts from a legacy
 * adapter, persists them as claims rows, and records the audit trail.
 *
 * This is the "ingest" half of the LegacyClaimsAdapter contract; the
 * write-back half lives in claimService (every state change checks the
 * claim's source_system and routes through adapterRegistry).
 *
 * Idempotency:
 *   - Each adapter's ingestClaims() is expected to skip already-migrated
 *     external_claim_ids (MockLegacyAdapter does this by querying the
 *     claims table for matching source_system + external_claim_id).
 *   - As a defensive belt-and-suspenders, we also re-check here before
 *     inserting, so a slow ingestClaims call during a concurrent migrate
 *     can't produce duplicates.
 */

const { supabase }       = require('./supabase');
const { getAdapter, SYSTEMS } = require('./legacy/adapterRegistry');
const logger             = require('../logger');

/**
 * Migrate claims from a legacy system into ClaimLayer.
 *
 * @param {string} sourceSystem  — e.g. 'mock_legacy'
 * @param {object} [filter]      — opaque, forwarded to adapter.ingestClaims
 * @returns {Promise<{ migrated: number, skipped: number, ids: string[] }>}
 */
async function migrateFromLegacy(sourceSystem, filter) {
  const adapter = getAdapter(sourceSystem);
  if (!adapter || adapter.system !== sourceSystem) {
    throw new Error(`Unknown source system: ${sourceSystem}`);
  }

  const drafts = await adapter.ingestClaims(filter);

  // Re-check on the inserter side. ingestClaims already filtered, but a
  // parallel migrate could have inserted between filter and now.
  const { data: existing } = await supabase
    .from('claims')
    .select('external_claim_id')
    .eq('source_system', sourceSystem);
  const seen = new Set((existing || []).map(r => r.external_claim_id));

  const ids     = [];
  let   skipped = 0;
  const now     = new Date().toISOString();

  for (const draft of drafts) {
    if (seen.has(draft.external_claim_id)) { skipped += 1; continue; }
    const claimId = `claim_legacy_${draft.external_claim_id}`;
    await _insertCanonicalClaim(claimId, draft, sourceSystem, now);
    ids.push(claimId);
    seen.add(draft.external_claim_id);
  }

  logger.info({
    msg: 'legacyMigrationService.migrateFromLegacy',
    sourceSystem, migrated: ids.length, skipped,
  });

  return { migrated: ids.length, skipped, ids };
}

async function _insertCanonicalClaim(claimId, draft, sourceSystem, now) {
  const claimNumber = `LEG-${(draft.external_claim_id || claimId).slice(-6)}`;
  await supabase.from('claims').insert({
    id:                 claimId,
    claim_number:       claimNumber,
    employer_id:        null,                // legacy claims may pre-date our employers table
    employee:           draft.employee || {},
    status:             draft.status || 'intake_complete',
    aww:                draft.aww    || null,
    td_rate:            draft.td_rate || null,
    weeks_calculated:   52,
    date_of_injury:     draft.date_of_injury,
    body_part:          draft.body_part,
    injury_type:        draft.injury_type,
    injury_description: draft.injury_description,
    employer_name:      draft.employer_name,
    filed_at:           now,
    source_system:      sourceSystem,
    external_claim_id:  draft.external_claim_id,
    sync_status:        'migrated',
    last_synced_at:     now,
    metadata:           { demo: true, migrated_from: sourceSystem, raw: draft.raw || null },
    created_at:         now,
    updated_at:         now,
  });

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'migrated_from_legacy',
    timestamp: now,
    data: {
      source_system:     sourceSystem,
      external_claim_id: draft.external_claim_id,
      status_at_migration: draft.status,
    },
  });
}

/**
 * Return all claims sourced from a legacy system (anything other than 'native').
 */
async function listMigrated() {
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .neq('source_system', 'native');
  if (error) throw new Error(error.message);
  return (data || []).sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at),
  );
}

module.exports = { migrateFromLegacy, listMigrated, SYSTEMS };
