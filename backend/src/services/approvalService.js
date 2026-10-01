'use strict';

/**
 * approvalService — the action-request lifecycle (ADR-0004).
 *
 *   propose  an agent or a human prepares a consequential action with its
 *            rationale and evidence → pending_approval
 *   decide   a different human, within authority, approves / modifies /
 *            rejects with a rationale
 *   execute  the system performs the approved payload as the approver
 *
 * Invariants enforced here (and, where possible, again by the database —
 * supabase/migrations/20261001000003_action_requests.sql):
 *   - agents may propose only PREPARE_FOR_APPROVAL actions (actionRegistry);
 *   - only humans decide; nobody decides their own proposal;
 *   - every decision carries a rationale;
 *   - authority is evaluated against the FINAL payload (a modification that
 *     raises the amount needs the authority for the raised amount);
 *   - MFA-flagged actions require an MFA-elevated approver session;
 *   - state transitions are conditional updates, so two approvers racing on
 *     one request cannot both win;
 *   - the request's tenant must equal the actor's tenant (first app-layer
 *     tenant check — a mismatch is a 404, never a disclosure);
 *   - every transition is written to the immutable audit ledger; proposal and
 *     decision entries are REQUIRED (no unaudited decision stands).
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');
const auditLedger  = require('./auditLedgerService');
const { getAction, AUTONOMY } = require('../policy/actionRegistry');
const { evaluateAuthority, claimContext, normalizeRole } = require('../policy/authorityPolicy');
const { getExecutor } = require('./actionExecutors');
const { mfaEnforced } = require('../middleware/auth');

const MIN_RATIONALE = 10;

class ApprovalError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function _id() {
  return `ar_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function _requireRationale(rationale, who) {
  const text = typeof rationale === 'string' ? rationale.trim() : '';
  if (text.length < MIN_RATIONALE) {
    throw new ApprovalError('RATIONALE_REQUIRED', `${who} must give a rationale of at least ${MIN_RATIONALE} characters`);
  }
  return text;
}

function _validatePayload(action, payload) {
  try {
    return action.validate(payload);
  } catch (e) {
    throw new ApprovalError('INVALID_PAYLOAD', e.message);
  }
}

async function _precheck(executor, ctx) {
  if (!executor.precheck) return;
  try {
    await executor.precheck(ctx);
  } catch (e) {
    if (e.code === 'PRECONDITION_FAILED') throw new ApprovalError('PRECONDITION_FAILED', e.message, 409);
    throw e;
  }
}

function _diff(before, after) {
  const changes = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      changes[key] = { from: before?.[key] ?? null, to: after?.[key] ?? null };
    }
  }
  return changes;
}

async function _loadClaimForPrincipal(claimId, principal) {
  const claimService = require('./claimService');
  const claim = await claimService.getClaim(claimId);
  const claimTenant = claim ? (claim.tenantId || config.tenancy.defaultTenantId) : null;
  if (!claim || claimTenant !== principal.tenantId) {
    throw new ApprovalError('CLAIM_NOT_FOUND', 'Claim not found', 404);
  }
  return claim;
}

async function getRequest(requestId, principal) {
  const { data, error } = await supabase
    .from('action_requests').select('*').eq('id', requestId).single();
  if (error || !data || (principal && data.tenant_id !== principal.tenantId)) {
    throw new ApprovalError('NOT_FOUND', 'Action request not found', 404);
  }
  return data;
}

// ── propose ──────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ request: object, idempotent: boolean }>}
 */
async function propose({ actionType, claimId, proposer, payload, rationale, evidence = [],
                         aiDecisionId = null, idempotencyKey = null, clientId = null }) {
  const action = getAction(actionType);
  if (!action) throw new ApprovalError('UNKNOWN_ACTION', `Unknown action type: ${actionType}`);
  if (!proposer || !['human', 'agent', 'system'].includes(proposer.type)) {
    throw new ApprovalError('INVALID_PROPOSER', 'A proposer principal is required');
  }
  // Policy first: an agent asking for an analyze-only action is refused for
  // that reason, whether or not an executor exists yet.
  if (proposer.type === 'agent') {
    if (action.agentAutonomy === AUTONOMY.ANALYZE_ONLY) {
      throw new ApprovalError('AGENT_ANALYZE_ONLY',
        `Agents may analyze ${actionType} but may not propose it; a human must originate it`, 403);
    }
    if (action.agentAutonomy === AUTONOMY.AUTONOMOUS) {
      throw new ApprovalError('AGENT_AUTONOMOUS_ACTION',
        `${actionType} is autonomous for agents and does not go through approval`);
    }
  }
  const executor = getExecutor(actionType);
  if (!executor || typeof action.validate !== 'function') {
    throw new ApprovalError('NOT_EXECUTABLE', `${actionType} has no executor yet`, 422);
  }
  if (!Array.isArray(evidence)) throw new ApprovalError('INVALID_EVIDENCE', 'evidence must be an array');
  const why = _requireRationale(rationale, 'The proposer');

  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from('action_requests').select('*').eq('idempotency_key', idempotencyKey);
    if (existing && existing.length) return { request: existing[0], idempotent: true };
  }

  const claim = await _loadClaimForPrincipal(claimId, proposer);
  const normalized = _validatePayload(action, payload);
  await _precheck(executor, { claimId, payload: normalized });

  const amountCents = action.amountCents(normalized);
  const authority = evaluateAuthority({
    actionId: actionType, principal: proposer, amountCents,
    context: claimContext(claim), clientId,
  });

  const now = new Date().toISOString();
  const row = {
    id:                     _id(),
    tenant_id:              claim.tenantId || config.tenancy.defaultTenantId,
    client_id:              clientId,
    claim_id:               claimId,
    action_type:            actionType,
    status:                 'pending_approval',
    proposed_by_type:       proposer.type,
    proposed_by:            proposer.id,
    proposed_by_role:       proposer.role || null,
    ai_decision_id:         aiDecisionId,
    proposal:               normalized,
    evidence,
    rationale:              why,
    amount_cents:           amountCents,
    authority_evaluation:   authority,
    required_approver_role: authority.requiredRole,
    policy_version:         authority.policyVersion,
    idempotency_key:        idempotencyKey,
    created_at:             now,
    updated_at:             now,
  };

  const { data: inserted, error } = await supabase.from('action_requests').insert(row).select().single();
  if (error) {
    if (error.code === '23505' && idempotencyKey) {
      const { data: existing } = await supabase
        .from('action_requests').select('*').eq('idempotency_key', idempotencyKey);
      if (existing && existing.length) return { request: existing[0], idempotent: true };
    }
    throw new Error(`approvalService.propose: ${error.message}`);
  }

  try {
    await auditLedger.append({
      actor:    proposer,
      action:   'action.proposed',
      entity:   { type: 'action_request', id: inserted.id },
      claimId,
      tenantId: inserted.tenant_id,
      payload:  {
        action_type: actionType, proposal: normalized, amount_cents: amountCents,
        rationale: why, required_approver_role: authority.requiredRole,
        policy_version: authority.policyVersion,
      },
      evidence: [...evidence, ...(aiDecisionId ? [{ type: 'ai_decision', id: aiDecisionId }] : [])],
    }, { required: true });
  } catch (e) {
    // An unaudited proposal must not sit in the queue.
    await supabase.from('action_requests')
      .update({ status: 'cancelled', cancelled_reason: 'audit_ledger_unavailable', updated_at: new Date().toISOString() })
      .eq('id', inserted.id).eq('status', 'pending_approval');
    throw new ApprovalError('AUDIT_UNAVAILABLE', 'The proposal could not be audited and was not queued', 503);
  }

  logger.info({ msg: 'approval: proposed', requestId: inserted.id, actionType, proposerType: proposer.type });
  return { request: inserted, idempotent: false };
}

// ── decide ───────────────────────────────────────────────────────────────────

/**
 * @param {string} requestId
 * @param {{ decision: 'approve'|'modify'|'reject', decider: object,
 *           rationale: string, modifiedPayload?: object }} input
 * @returns {Promise<{ request: object }>} the request after the decision
 *          (and, for approvals, after execution)
 */
async function decide(requestId, { decision, decider, rationale, modifiedPayload }) {
  if (!['approve', 'modify', 'reject'].includes(decision)) {
    throw new ApprovalError('INVALID_DECISION', "decision must be 'approve', 'modify' or 'reject'");
  }
  if (!decider || decider.type !== 'human') {
    throw new ApprovalError('HUMAN_DECISION_REQUIRED', 'Only a human may decide an action request', 403);
  }
  const why = _requireRationale(rationale, 'The decision');

  const request = await getRequest(requestId, decider);
  if (request.status !== 'pending_approval') {
    throw new ApprovalError('NOT_PENDING', `Action request is ${request.status}`, 409);
  }
  if (decider.id === request.proposed_by) {
    throw new ApprovalError('SELF_APPROVAL', 'You cannot decide your own proposal', 403);
  }
  if (!normalizeRole(decider.role)) {
    throw new ApprovalError('INSUFFICIENT_AUTHORITY', `Role '${decider.role}' carries no claims authority`, 403);
  }

  const action = getAction(request.action_type);
  const executor = getExecutor(request.action_type);
  let finalPayload = request.proposal;
  let modifications = null;
  let authority = null;

  if (decision !== 'reject') {
    if (decision === 'modify') {
      finalPayload = _validatePayload(action, modifiedPayload);
      modifications = _diff(request.proposal, finalPayload);
      if (!Object.keys(modifications).length) {
        throw new ApprovalError('NO_MODIFICATION', "The modified payload is identical to the proposal — use 'approve'");
      }
    }
    const claim = await _loadClaimForPrincipal(request.claim_id, decider);
    authority = evaluateAuthority({
      actionId: request.action_type, principal: decider,
      amountCents: action.amountCents(finalPayload),
      context: claimContext(claim), clientId: request.client_id,
    });
    if (!authority.withinAuthority) {
      throw new ApprovalError('INSUFFICIENT_AUTHORITY',
        `This decision requires ${authority.requiredRole || 'out-of-policy'} authority`, 403,
        { required_role: authority.requiredRole, reasons: authority.reasons });
    }
    if (action.requiresMfa && mfaEnforced() && !decider.mfa) {
      throw new ApprovalError('MFA_REQUIRED', 'Approving this action requires an MFA-verified session', 403);
    }
    await _precheck(executor, { claimId: request.claim_id, payload: finalPayload });
  }

  const now = new Date().toISOString();
  const newStatus = decision === 'reject' ? 'rejected' : 'approved';
  const { data: claimed, error } = await supabase.from('action_requests')
    .update({
      status:             newStatus,
      decision,
      decided_by:         decider.id,
      decided_by_role:    decider.role,
      decision_rationale: why,
      decision_authority: authority,
      approved_payload:   decision === 'reject' ? null : finalPayload,
      modifications,
      decided_at:         now,
      updated_at:         now,
    })
    .eq('id', requestId).eq('status', 'pending_approval')
    .select();
  if (error) throw new Error(`approvalService.decide: ${error.message}`);
  if (!claimed || !claimed.length) {
    throw new ApprovalError('NOT_PENDING', 'Action request was decided by someone else', 409);
  }

  const ledgerAction = { approve: 'action.approved', modify: 'action.modified', reject: 'action.rejected' }[decision];
  try {
    await auditLedger.append({
      actor:    decider,
      action:   ledgerAction,
      entity:   { type: 'action_request', id: requestId },
      claimId:  request.claim_id,
      tenantId: request.tenant_id,
      payload:  {
        action_type: request.action_type, decision, rationale: why,
        approved_payload: decision === 'reject' ? null : finalPayload,
        modifications, authority,
      },
      evidence: [{ type: 'action_request', id: requestId }],
    }, { required: true });
  } catch (e) {
    // No unaudited decision stands: put the request back in the queue.
    await supabase.from('action_requests').update({
      status: 'pending_approval', decision: null, decided_by: null, decided_by_role: null,
      decision_rationale: null, decision_authority: null, approved_payload: null,
      modifications: null, decided_at: null, updated_at: new Date().toISOString(),
    }).eq('id', requestId).eq('status', newStatus);
    throw new ApprovalError('AUDIT_UNAVAILABLE', 'The decision could not be audited and was not recorded', 503);
  }

  logger.info({ msg: 'approval: decided', requestId, decision, deciderRole: decider.role });
  if (decision === 'reject') return { request: claimed[0] };
  return execute(requestId, decider);
}

// ── execute ──────────────────────────────────────────────────────────────────

/**
 * Execute an approved request (or retry a failed execution). Idempotent: an
 * already-executed request returns its stored result.
 */
async function execute(requestId, actor) {
  if (!actor || actor.type !== 'human') {
    throw new ApprovalError('HUMAN_DECISION_REQUIRED', 'Execution is triggered by a human decision', 403);
  }
  const request = await getRequest(requestId, actor);
  if (request.status === 'executed') return { request, idempotent: true };
  if (!['approved', 'execution_failed'].includes(request.status)) {
    throw new ApprovalError('NOT_EXECUTABLE', `Action request is ${request.status}`, 409);
  }
  if (request.status === 'execution_failed') {
    // A retry is a fresh exercise of authority by whoever triggers it.
    const action = getAction(request.action_type);
    const claim = await _loadClaimForPrincipal(request.claim_id, actor);
    const authority = evaluateAuthority({
      actionId: request.action_type, principal: actor,
      amountCents: action.amountCents(request.approved_payload),
      context: claimContext(claim), clientId: request.client_id,
    });
    if (!authority.withinAuthority) {
      throw new ApprovalError('INSUFFICIENT_AUTHORITY', 'Retrying requires the same authority as approving', 403,
        { required_role: authority.requiredRole, reasons: authority.reasons });
    }
    if (action.requiresMfa && mfaEnforced() && !actor.mfa) {
      throw new ApprovalError('MFA_REQUIRED', 'Retrying this action requires an MFA-verified session', 403);
    }
  }

  const { data: claimed, error } = await supabase.from('action_requests')
    .update({
      status: 'executing',
      execution_attempts: (request.execution_attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId).eq('status', request.status)
    .select();
  if (error) throw new Error(`approvalService.execute: ${error.message}`);
  if (!claimed || !claimed.length) throw new ApprovalError('NOT_EXECUTABLE', 'Action request is already executing', 409);

  // The approver is the authority behind the action, whoever clicked retry.
  // (MFA was verified at decision time when the action required it.)
  const approver = {
    type: 'human', id: request.decided_by, role: request.decided_by_role,
    tenantId: request.tenant_id,
  };
  const executor = getExecutor(request.action_type);

  try {
    const result = await executor.execute({
      request, claimId: request.claim_id, payload: request.approved_payload, approver,
    });
    const { data: done } = await supabase.from('action_requests').update({
      status: 'executed', executed_by: actor.id, executed_at: new Date().toISOString(),
      execution_result: result || {}, execution_error: null, updated_at: new Date().toISOString(),
    }).eq('id', requestId).eq('status', 'executing').select().single();

    // The action already happened: this ledger write cannot gate it, so it is
    // best-effort with a loud log (the executor's own records also exist).
    await auditLedger.append({
      actor, action: 'action.executed',
      entity: { type: 'action_request', id: requestId },
      claimId: request.claim_id, tenantId: request.tenant_id,
      payload: { action_type: request.action_type, result: result || {}, authorized_by: request.decided_by },
      evidence: [{ type: 'action_request', id: requestId }],
    });
    logger.info({ msg: 'approval: executed', requestId, actionType: request.action_type });
    return { request: done };
  } catch (e) {
    logger.error({ msg: 'approval: execution failed', requestId, actionType: request.action_type, err: e.message });
    const { data: failed } = await supabase.from('action_requests').update({
      status: 'execution_failed', execution_error: e.message, updated_at: new Date().toISOString(),
    }).eq('id', requestId).eq('status', 'executing').select().single();
    await auditLedger.append({
      actor, action: 'action.execution_failed',
      entity: { type: 'action_request', id: requestId },
      claimId: request.claim_id, tenantId: request.tenant_id,
      payload: { action_type: request.action_type, error: e.message },
    });
    return { request: failed };
  }
}

// ── supersede ────────────────────────────────────────────────────────────────

/**
 * Cancel pending requests made moot by a decision taken through another path
 * (e.g. an adjuster approves an RFA directly while an agent proposal for the
 * same RFA waits in the queue). Best-effort; never throws.
 */
async function supersedePending({ actionType, matches, actor, reason }) {
  try {
    const { data } = await supabase.from('action_requests')
      .select('*').eq('action_type', actionType).eq('status', 'pending_approval');
    for (const req of (data || []).filter(r => matches(r.proposal || {}))) {
      const { data: cancelled } = await supabase.from('action_requests').update({
        status: 'cancelled', cancelled_reason: reason, updated_at: new Date().toISOString(),
      }).eq('id', req.id).eq('status', 'pending_approval').select();
      if (cancelled && cancelled.length) {
        await auditLedger.append({
          actor, action: 'action.cancelled',
          entity: { type: 'action_request', id: req.id },
          claimId: req.claim_id, tenantId: req.tenant_id,
          payload: { action_type: actionType, reason },
        });
      }
    }
  } catch (e) {
    logger.error({ msg: 'approval: supersede failed (non-fatal)', actionType, err: e.message });
  }
}

// ── queries ──────────────────────────────────────────────────────────────────

async function listRequests({ tenantId, claimId = null, status = null, limit = 100 }) {
  let q = supabase.from('action_requests').select('*').eq('tenant_id', tenantId);
  if (claimId) q = q.eq('claim_id', claimId);
  if (status)  q = q.eq('status', status);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`approvalService.listRequests: ${error.message}`);
  return data || [];
}

function isExecutable(actionId) {
  const action = getAction(actionId);
  return !!(action && typeof action.validate === 'function' && getExecutor(actionId));
}

module.exports = {
  propose, decide, execute, supersedePending, getRequest, listRequests, isExecutable,
  ApprovalError, MIN_RATIONALE,
};
