'use strict';

/**
 * Authority policy — who may approve or execute a consequential action
 * (ADR-0004). Pure and deterministic: same inputs, same answer, no I/O, so
 * every evaluation can be snapshotted onto the action request and replayed.
 *
 * Three inputs decide authority:
 *   1. the actor's role level and that role's monetary limit for the action;
 *   2. escalation rules keyed to claim characteristics (litigated,
 *      represented, risk flags) that raise the minimum role;
 *   3. client overrides that may only TIGHTEN limits (a staffing client's
 *      service agreement can require lower authority, never grant more).
 *
 * The dollar figures below are PLACEHOLDER BUSINESS LIMITS for development.
 * They are not legal rules. Production values come from TPA management and
 * each client's service agreement, and will move to per-user authority grants
 * in the database (Sprint 3).
 */

const ROLE_LEVELS = Object.freeze({
  adjuster:       1,
  supervisor:     2,
  claims_manager: 3,
});

// Legacy compatibility. Before this framework the only role with write
// access was `admin`, so every claims professional had to be an admin.
// Until roles are split (Sprint 3), admin carries claims-manager authority.
// Recorded as a separation-of-duties gap (finding S-4): system administration
// and claims authority must become different grants.
const ROLE_ALIASES = Object.freeze({ admin: 'claims_manager' });

const DEFAULT_AUTHORITY_POLICY = Object.freeze({
  version: 'authority-default@2026-10-01',
  // Maximum cents per action, per role. A role absent from an action's map
  // has no authority for that action.
  limits: {
    'reserve.change':       { adjuster: 5_000_000, supervisor: 25_000_000, claims_manager: 100_000_000 },
    'payment.issue':        { adjuster: 1_000_000, supervisor:  5_000_000, claims_manager:  25_000_000 },
    'settlement.authority': {                      supervisor:  5_000_000, claims_manager:  25_000_000 },
    'settlement.offer':     {                      supervisor:  5_000_000, claims_manager:  25_000_000 },
  },
  // Minimum role for actions without a monetary basis.
  minRole: {
    'medical.rfa.approve':         'adjuster',
    'claim.compensability.accept': 'adjuster',
    'claim.compensability.delay':  'adjuster',
    'claim.compensability.deny':   'adjuster',
    'notice.send':                 'adjuster',
    'benefit.td.start':            'adjuster',
    'benefit.td.stop':             'adjuster',
    'benefit.aww.adopt':           'adjuster',
    'claim.close':                 'supervisor',
    'claim.reopen':                'supervisor',
    'siu.referral':                'adjuster',
  },
  // Claim characteristics that raise the minimum role.
  escalations: [
    { id: 'litigated_claim',   when: { litigated: true },          minRole: 'supervisor',
      actions: ['reserve.change', 'payment.issue', 'claim.close'] },
    { id: 'represented_claim', when: { represented: true },        minRole: 'claims_manager',
      actions: ['settlement.authority', 'settlement.offer'] },
    { id: 'siu_flag',          when: { riskFlag: 'siu_referral' }, minRole: 'supervisor',
      actions: ['payment.issue', 'reserve.change', 'benefit.td.start'] },
  ],
  // { [clientId]: { limits: { [actionId]: { [role]: cents } } } } — tighten only.
  clientOverrides: {},
});

function normalizeRole(role) {
  if (!role) return null;
  const r = ROLE_ALIASES[role] || role;
  return ROLE_LEVELS[r] ? r : null;
}

function _rolesAscending() {
  return Object.keys(ROLE_LEVELS).sort((a, b) => ROLE_LEVELS[a] - ROLE_LEVELS[b]);
}

function _escalationApplies(rule, actionId, ctx) {
  if (!rule.actions.includes(actionId)) return false;
  const w = rule.when || {};
  if (w.litigated === true && !ctx.litigated) return false;
  if (w.represented === true && !ctx.represented) return false;
  if (w.riskFlag && !(ctx.riskFlags || []).includes(w.riskFlag)) return false;
  return true;
}

function _effectiveLimit(policy, actionId, role, clientId) {
  const base = policy.limits[actionId]?.[role];
  if (base == null) return null;
  const override = clientId ? policy.clientOverrides?.[clientId]?.limits?.[actionId]?.[role] : undefined;
  return override == null ? base : Math.min(base, override);
}

/**
 * Derive the claim characteristics authority depends on. Kept here so the
 * definition of "litigated" or "represented" for authority purposes lives
 * next to the rules that use it.
 */
function claimContext(claim) {
  if (!claim) return { litigated: false, represented: false, riskFlags: [] };
  return {
    litigated:   claim.status === 'litigated',
    represented: !!(claim.attorney_represented || claim.attorneyName || claim.attorney_name),
    riskFlags:   Array.isArray(claim.riskFlags) ? claim.riskFlags : [],
  };
}

/**
 * @param {object} args
 * @param {string} args.actionId
 * @param {{type:string, role:string}} args.principal
 * @param {number|null} args.amountCents  — required for monetary actions
 * @param {object} [args.context]          — claimContext(claim)
 * @param {string} [args.clientId]
 * @param {object} [args.policy]
 * @returns {{ policyVersion, actionId, actorRole, amountCents, actorLimitCents,
 *             requiredRole, withinAuthority, reasons: string[] }}
 */
function evaluateAuthority({ actionId, principal, amountCents = null, context = {},
                             clientId = null, policy = DEFAULT_AUTHORITY_POLICY }) {
  const reasons = [];
  const monetary = Object.prototype.hasOwnProperty.call(policy.limits, actionId);
  if (monetary && !Number.isSafeInteger(amountCents)) {
    throw new Error(`evaluateAuthority: ${actionId} is monetary and requires amountCents`);
  }

  // Floor role: the action's own minimum plus any escalation that applies.
  let floor = policy.minRole[actionId] || 'adjuster';
  for (const rule of policy.escalations) {
    if (_escalationApplies(rule, actionId, context) && ROLE_LEVELS[rule.minRole] > ROLE_LEVELS[floor]) {
      floor = rule.minRole;
      reasons.push(`escalation '${rule.id}' requires at least ${rule.minRole}`);
    }
  }

  // Required role: the lowest role at or above the floor that covers the amount.
  let requiredRole = null;
  for (const role of _rolesAscending()) {
    if (ROLE_LEVELS[role] < ROLE_LEVELS[floor]) continue;
    if (!monetary) { requiredRole = role; break; }
    const limit = _effectiveLimit(policy, actionId, role, clientId);
    if (limit != null && limit >= amountCents) { requiredRole = role; break; }
  }
  if (!requiredRole) {
    reasons.push('amount exceeds every configured authority limit — requires out-of-policy approval');
  }

  const actorRole = normalizeRole(principal?.role);
  const actorLimitCents = monetary && actorRole ? _effectiveLimit(policy, actionId, actorRole, clientId) : null;

  let withinAuthority = true;
  if (!principal || principal.type !== 'human') {
    withinAuthority = false;
    reasons.push('only a human may hold approval authority');
  } else if (!actorRole) {
    withinAuthority = false;
    reasons.push(`role '${principal.role}' carries no claims authority`);
  } else if (ROLE_LEVELS[actorRole] < ROLE_LEVELS[floor]) {
    withinAuthority = false;
    reasons.push(`${actorRole} is below the required minimum role ${floor}`);
  } else if (monetary && (actorLimitCents == null || actorLimitCents < amountCents)) {
    withinAuthority = false;
    reasons.push(`amount ${amountCents} cents exceeds ${actorRole} limit ${actorLimitCents ?? 0} cents`);
  }

  return {
    policyVersion: policy.version,
    actionId,
    actorRole,
    amountCents: monetary ? amountCents : null,
    actorLimitCents,
    requiredRole,
    withinAuthority,
    reasons,
  };
}

module.exports = {
  ROLE_LEVELS, ROLE_ALIASES, DEFAULT_AUTHORITY_POLICY,
  evaluateAuthority, claimContext, normalizeRole,
};
