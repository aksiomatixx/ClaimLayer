'use strict';

/**
 * auditLedgerService — the append-only, hash-chained record of consequential
 * actions (ADR-0003; supabase/migrations/20261001000002_audit_ledger.sql).
 *
 * The database owns the integrity guarantees: it assigns seq / prev_hash /
 * hash / recorded_at under a per-tenant lock and rejects UPDATE, DELETE and
 * TRUNCATE. This module only validates and shapes entries, so a malformed
 * entry fails here with a clear message instead of a constraint error.
 *
 * Entry vocabulary:
 *   action       dotted, lower-case: '<domain>.<event>' e.g. 'claim.status_changed',
 *                'reserve.approved', 'action.proposed', 'agent.recommendation_recorded'
 *   actor        a principal (policy/principal.js) — who or what did it
 *   entity       { type, id } the record acted on
 *   payload      structured facts of the action (amounts in integer cents;
 *                no document text, no raw model output)
 *   evidence     [{ type, id, ... }] — what the action relied on
 *
 * Failure semantics: `required: true` throws, so an operation whose audit
 * record could not be written does not proceed. Best-effort appends log and
 * return null — used only by legacy dual-write paths that are not yet
 * transactional (see ADR-0003, "Interim").
 */

const { supabase }   = require('./supabase');
const config         = require('../config');
const logger         = require('../logger');
const { ledgerActor } = require('../policy/principal');

const ACTION_RE   = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const ACTOR_TYPES = ['human', 'agent', 'system', 'integration'];

function _plainObject(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`audit ledger ${field} must be an object`);
  }
  return JSON.parse(JSON.stringify(value)); // drops undefined; rejects cycles
}

function _plainArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`audit ledger ${field} must be an array`);
  return JSON.parse(JSON.stringify(value));
}

/** Validate and shape a ledger row. Exported for tests. */
function buildEntry({ actor, action, entity, claimId, payload, evidence, occurredAt,
                      requestId, correlationId, causationId, tenantId }) {
  if (!actor || !ACTOR_TYPES.includes(actor.type)) {
    throw new Error(`audit ledger actor.type must be one of ${ACTOR_TYPES.join(', ')}`);
  }
  if (!ACTION_RE.test(action || '')) {
    throw new Error(`audit ledger action '${action}' must be dotted lower-case (e.g. 'claim.status_changed')`);
  }
  return {
    tenant_id:      tenantId || actor.tenantId || config.tenancy.defaultTenantId,
    ...ledgerActor(actor),
    action,
    entity_type:    entity?.type || null,
    entity_id:      entity?.id != null ? String(entity.id) : null,
    claim_id:       claimId || null,
    request_id:     requestId || null,
    correlation_id: correlationId || null,
    causation_id:   causationId || null,
    occurred_at:    occurredAt || new Date().toISOString(),
    payload:        _plainObject(payload, 'payload'),
    evidence:       _plainArray(evidence, 'evidence'),
  };
}

/**
 * Append one entry. Returns the stored row (with the database-assigned seq
 * and hash), or null when a best-effort append failed.
 */
async function append(entry, { required = false } = {}) {
  let row;
  try {
    row = buildEntry(entry);
  } catch (err) {
    // A malformed entry is a programming error — always loud.
    logger.error({ msg: 'auditLedger: invalid entry', action: entry?.action, err: err.message });
    throw err;
  }

  const { data, error } = await supabase.from('audit_ledger').insert(row).select().single();
  if (!error && data) return data;

  const message = error?.message || 'no row returned';
  if (required) {
    logger.error({ msg: 'auditLedger: REQUIRED append failed', action: row.action, claimId: row.claim_id, err: message });
    throw new Error(`Audit ledger append failed for ${row.action}: ${message}`);
  }
  logger.error({ msg: 'auditLedger: best-effort append failed', action: row.action, claimId: row.claim_id, err: message });
  return null;
}

/** A claim's ledger history in chain order. */
async function listForClaim(claimId, { limit = 500 } = {}) {
  const { data, error } = await supabase
    .from('audit_ledger').select('*').eq('claim_id', claimId)
    .order('seq', { ascending: true }).limit(limit);
  if (error) throw new Error(`auditLedger.listForClaim: ${error.message}`);
  return data || [];
}

module.exports = { append, listForClaim, buildEntry, ACTION_RE, ACTOR_TYPES };
