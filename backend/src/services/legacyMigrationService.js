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

const crypto             = require('crypto');
const { supabase }       = require('./supabase');
const { getAdapter, SYSTEMS } = require('./legacy/adapterRegistry');
const logger             = require('../logger');

// claims.id is VARCHAR(60). Short, filesystem-safe external ids keep the
// readable form; anything longer (or carrying unsafe characters) gets a
// deterministic hash — bounded, and collision-resistant where plain
// truncation would not be.
const CLAIM_ID_PREFIX = 'claim_legacy_';
const CLAIM_ID_MAX    = 60;

function _legacyClaimId(externalId) {
  const ext = String(externalId);
  if (/^[A-Za-z0-9_-]+$/.test(ext) && CLAIM_ID_PREFIX.length + ext.length <= CLAIM_ID_MAX) {
    return `${CLAIM_ID_PREFIX}${ext}`;
  }
  const hash = crypto.createHash('sha256').update(ext).digest('hex').slice(0, 32);
  return `${CLAIM_ID_PREFIX}h${hash}`;
}

/**
 * Deterministic, uniqueness-safe migrated claim number. The readable
 * `LEG-<last 6>` is kept when free; if another external id already owns
 * that suffix, a short content hash disambiguates — same external id
 * always yields the same number, different ids never share one.
 */
async function _legacyClaimNumber(externalId, claimId) {
  const ext = String(externalId || claimId);
  const base = `LEG-${ext.slice(-6)}`;
  const candidates = [base, `${base}-${crypto.createHash('sha256').update(ext).digest('hex').slice(0, 4).toUpperCase()}`];
  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from('claims').select('id, external_claim_id').eq('claim_number', candidate);
    if (error) throw new Error(`legacyMigration: claim_number lookup failed — ${error.message}`);
    const holder = (data || [])[0];
    if (!holder || holder.external_claim_id === externalId) return candidate;
  }
  // Two distinct external ids colliding on suffix AND 4-hex-char hash:
  // fall back to the full-entropy form.
  return `LEG-${crypto.createHash('sha256').update(ext).digest('hex').slice(0, 12).toUpperCase()}`;
}

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

  const ids      = [];
  const failures = [];
  let   skipped  = 0;
  const now      = new Date().toISOString();

  for (const draft of drafts) {
    if (seen.has(draft.external_claim_id)) { skipped += 1; continue; }
    const claimId = _legacyClaimId(draft.external_claim_id);
    try {
      await _insertCanonicalClaim(claimId, draft, sourceSystem, now);
      ids.push(claimId);
      seen.add(draft.external_claim_id);
    } catch (e) {
      // A failed insert is a FAILURE, never a silent success: counts
      // must be truthful, and the draft stays migratable on a re-run.
      logger.error({ msg: 'legacyMigrationService: claim migration failed', external_claim_id: draft.external_claim_id, err: e.message });
      failures.push({ external_claim_id: draft.external_claim_id, error: e.message });
    }
  }

  logger.info({
    msg: 'legacyMigrationService.migrateFromLegacy',
    sourceSystem, migrated: ids.length, skipped, failed: failures.length,
  });

  return { migrated: ids.length, skipped, failed: failures.length, failures, ids };
}

async function _insertCanonicalClaim(claimId, draft, sourceSystem, now) {
  const claimNumber = await _legacyClaimNumber(draft.external_claim_id, claimId);
  const { error: insErr } = await supabase.from('claims').insert({
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
  if (insErr) throw new Error(`claims insert failed — ${insErr.message}`);

  const { error: evErr } = await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'migrated_from_legacy',
    timestamp: now,
    data: {
      source_system:     sourceSystem,
      external_claim_id: draft.external_claim_id,
      status_at_migration: draft.status,
    },
  });
  if (evErr) {
    // Compensate: a migrated claim without its migration event is a
    // half-written unit — remove it so the re-run can repeat cleanly.
    await supabase.from('claims').delete().eq('id', claimId);
    throw new Error(`migration event insert failed — ${evErr.message}`);
  }
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
