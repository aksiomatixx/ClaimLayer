'use strict';

/**
 * benefitAudit.js — the audit record for benefit and settlement actions
 * (TD periods, PD, C&R, award disbursements).
 *
 * Each action writes two records:
 *   - an immutable audit_ledger entry (ADR-0003), carrying the claim id so it
 *     shows in the claim's history;
 *   - the legacy audit_log row the older screens read.
 *
 * Inside a unit of work (tx) both writes are part of the unit: if either fails,
 * the action does not commit (ADR-0006). Swallowing a failed statement there
 * would abort the PostgreSQL transaction and surface later as a confusing
 * error, or commit the action without its record. Outside a unit (older
 * callers), the writes are best-effort, as they always were.
 */

const { supabase }  = require('./supabase');
const auditLedger   = require('./auditLedgerService');
const logger        = require('../logger');

const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'system', role: 'system' });

// Entity type → the table that holds it (each row carries its claim_id).
const ENTITY_TABLES = Object.freeze({
  pd_evaluation:      'pd_evaluations',
  pd_advance:         'pd_advances',
  stipulation:        'stipulations',
  settlement_offer:   'settlement_offers',
  award_disbursement: 'award_disbursements',
  td_period:          'td_periods',
});

async function _claimIdOf(tx, entityType, entityId) {
  if (entityType === 'claim') return entityId || null;
  const table = ENTITY_TABLES[entityType];
  if (!table || !entityId) return null;
  if (tx) {
    const row = await tx.selectOne(table, { id: entityId });
    return row ? row.claim_id || null : null;
  }
  const { data } = await supabase.from(table).select('claim_id').eq('id', entityId).limit(1);
  return data && data[0] ? data[0].claim_id || null : null;
}

/**
 * @param {object} p
 * @param {object|null} p.tx           the caller's unit of work, if any
 * @param {object|null} p.actor        principal ({type,id,role}); system if absent
 * @param {string} p.action            ledger action, e.g. 'pd.advance_payment'
 * @param {string} p.entityType        e.g. 'pd_advance'
 * @param {string} p.entityId
 * @param {string|null} [p.claimId]    resolved from the entity when omitted
 * @param {string} p.legacyAction      audit_log.action
 * @param {string} p.description
 * @param {*} p.newValue
 * @param {string} [p.userRole]
 */
async function recordAudit({ tx = null, actor = null, action, entityType, entityId, claimId = null,
                             legacyAction, description, newValue, userRole = 'system' }) {
  const payload = (newValue && typeof newValue === 'object') ? newValue : { description, value: newValue };
  const legacy = {
    action:        legacyAction,
    resource_type: entityType,
    resource_id:   entityId,
    description,
    new_value:     newValue,
    user_role:     userRole,
    created_at:    new Date().toISOString(),
  };

  if (tx) {
    const resolvedClaimId = claimId || await _claimIdOf(tx, entityType, entityId);
    await auditLedger.append({
      actor: actor || SYSTEM_ACTOR, action, entity: { type: entityType, id: entityId },
      claimId: resolvedClaimId, payload,
    }, { tx });
    await tx.insert('audit_log', legacy);
    return;
  }

  try {
    const resolvedClaimId = claimId || await _claimIdOf(null, entityType, entityId);
    await auditLedger.append({
      actor: actor || SYSTEM_ACTOR, action, entity: { type: entityType, id: entityId },
      claimId: resolvedClaimId, payload,
    });
  } catch (err) {
    logger.error({ msg: 'benefitAudit: ledger append failed (no unit of work)', action, err: err.message });
  }
  const { error } = await supabase.from('audit_log').insert(legacy);
  if (error) logger.error({ msg: 'benefitAudit: audit_log write failed', action: legacyAction, err: error.message });
}

module.exports = { recordAudit, SYSTEM_ACTOR, _claimIdOf };
