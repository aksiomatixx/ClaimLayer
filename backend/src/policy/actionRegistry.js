'use strict';

/**
 * Action registry — every consequential action type, declared once, with the
 * autonomy an AI agent has over it (ADR-0004).
 *
 *   AUTONOMOUS            an agent may execute it (reversible, non-consequential,
 *                         audited) — e.g. classify a document, create a review task.
 *   PREPARE_FOR_APPROVAL  an agent may PROPOSE it as an action request; a human
 *                         with sufficient authority approves, modifies or rejects;
 *                         the system executes.
 *   ANALYZE_ONLY          an agent may analyze and recommend in narrative form but
 *                         may not create an executable proposal. Only a human can
 *                         originate the action (denials, settlement authority,
 *                         litigation positions, physician-only UR outcomes).
 *
 * The registry is code, not configuration: changing an action's agent
 * autonomy is a reviewed code change with an ADR, never a runtime toggle.
 *
 * Monetary authority limits live in authorityPolicy.js; this file says
 * whether an action is monetary (`amountCents`) and whether approving it
 * requires an MFA-elevated session (`requiresMfa`).
 */

const { assertCents } = require('../utils/money');

// Mirrors paymentLedgerService (and the payment_transactions CHECKs), kept
// here so the policy layer has no service dependency.
const PAYMENT_TYPES = Object.freeze(['td_temporary_disability', 'pd_advance', 'stip_award',
  'cnr_settlement', 'medical_treatment', 'legal_expense', 'bill_review_fee']);
const PAYMENT_METHODS = Object.freeze(['check', 'ach', 'digital_card']);

const AUTONOMY = Object.freeze({
  AUTONOMOUS:           'autonomous',
  PREPARE_FOR_APPROVAL: 'prepare_for_approval',
  ANALYZE_ONLY:         'analyze_only',
});

class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_PAYLOAD';
  }
}

// Sanity ceiling on any single reserve bucket: $100M. Not a business
// authority limit (authorityPolicy.js) — a guard against unit errors
// (dollars sent as cents ×100, etc.).
const MAX_BUCKET_CENTS = 10_000_000_000;

function _plainPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PayloadError('payload must be an object');
  }
  return payload;
}

function _reason(value, field = 'reason') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 3 || text.length > 2000) {
    throw new PayloadError(`${field} must be 3–2000 characters`);
  }
  return text;
}

const ACTIONS = {
  // ── Autonomous (agents execute; listed so the catalog is complete) ────────
  'document.classify': {
    domain: 'documents', agentAutonomy: AUTONOMY.AUTONOMOUS, financial: false,
    description: 'Classify an inbound document into the controlled category list.',
  },
  'document.file_to_claim': {
    domain: 'documents', agentAutonomy: AUTONOMY.AUTONOMOUS, financial: false,
    description: 'File a document to a claim when the match is deterministic; otherwise route to triage.',
  },
  'task.create_review': {
    domain: 'workflow', agentAutonomy: AUTONOMY.AUTONOMOUS, financial: false,
    description: 'Create a review task (diary) for a human.',
  },
  'correspondence.draft': {
    domain: 'communications', agentAutonomy: AUTONOMY.AUTONOMOUS, financial: false,
    description: 'Draft correspondence. Drafting never sends.',
  },
  'exception.flag': {
    domain: 'oversight', agentAutonomy: AUTONOMY.AUTONOMOUS, financial: false,
    description: 'Raise a file-audit exception for supervisor review.',
  },

  // ── Prepare for approval ───────────────────────────────────────────────────
  'reserve.change': {
    domain: 'financial', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: true,
    requiresMfa: true,
    description: 'Set the claim reserves (medical, indemnity, expense). Authority is measured on the resulting total reserve.',
    validate(payload) {
      const p = _plainPayload(payload);
      const out = {};
      for (const bucket of ['medical_cents', 'indemnity_cents', 'expense_cents']) {
        try {
          assertCents(p[bucket], bucket);
        } catch (e) {
          throw new PayloadError(e.message);
        }
        if (p[bucket] > MAX_BUCKET_CENTS) {
          throw new PayloadError(`${bucket} exceeds the per-bucket sanity ceiling — check units (cents)`);
        }
        out[bucket] = p[bucket];
      }
      out.reason = _reason(p.reason);
      return out;
    },
    amountCents: (p) => p.medical_cents + p.indemnity_cents + p.expense_cents,
    entityOf: (_p, claimId) => ({ type: 'claim', id: claimId }),
  },
  'medical.rfa.approve': {
    domain: 'medical', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: false,
    requiresMfa: false,
    description: 'Approve a Request for Authorization for treatment. Agents recommend; a human approves (finding S-5).',
    validate(payload) {
      const p = _plainPayload(payload);
      if (typeof p.rfa_id !== 'string' || !p.rfa_id.trim()) {
        throw new PayloadError('rfa_id is required');
      }
      return { rfa_id: p.rfa_id.trim() };
    },
    amountCents: () => null,
    entityOf: (p) => ({ type: 'rfa', id: p.rfa_id }),
  },
  'payment.issue': {
    domain: 'financial', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: true,
    requiresMfa: true,
    description: 'Issue a benefit or expense payment via the authoritative payment ledger.',
    validate(payload) {
      const p = _plainPayload(payload);
      const out = {};
      try {
        assertCents(p.amount_cents, 'amount_cents');
      } catch (e) {
        throw new PayloadError(e.message);
      }
      if (p.amount_cents <= 0) {
        throw new PayloadError('amount_cents must be positive');
      }
      if (!['indemnity', 'medical', 'expense'].includes(p.category)) {
        throw new PayloadError('category must be indemnity, medical, or expense');
      }
      if (!PAYMENT_TYPES.includes(p.payment_type)) {
        throw new PayloadError(`payment_type must be one of: ${PAYMENT_TYPES.join(', ')}`);
      }
      if (p.method != null && !PAYMENT_METHODS.includes(p.method)) {
        throw new PayloadError(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);
      }
      for (const k of ['period_start', 'period_end']) {
        if (p[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(p[k]))) {
          throw new PayloadError(`${k} must be YYYY-MM-DD`);
        }
      }
      out.amount_cents = p.amount_cents;
      out.category = p.category;
      out.payment_type = p.payment_type;
      out.payee_id = p.payee_id || null;
      out.method = p.method || 'check';
      out.check_number = p.check_number || null;
      out.memo = p.memo ? String(p.memo).slice(0, 500) : null;
      out.period_start = p.period_start || null;
      out.period_end = p.period_end || null;
      return out;
    },
    amountCents: (p) => p.amount_cents,
    entityOf: (_p, claimId) => ({ type: 'claim', id: claimId }),
  },
  'claim.compensability.accept': {
    domain: 'claims', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: false,
    description: 'Accept compensability of the claim or a body part.',
  },
  'claim.compensability.delay': {
    domain: 'claims', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: false,
    description: 'Delay the compensability decision pending investigation.',
  },
  'benefit.td.start': {
    domain: 'benefits', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: true,
    requiresMfa: true,
    description: 'Start a temporary disability benefit period.',
  },
  'benefit.td.stop': {
    domain: 'benefits', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: true,
    requiresMfa: true,
    description: 'End or suspend a temporary disability benefit period.',
  },
  'benefit.aww.adopt': {
    domain: 'benefits', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: true,
    requiresMfa: false,
    description: 'Adopt an average weekly wage calculation as the basis for benefits.',
  },
  'notice.send': {
    domain: 'communications', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: false,
    description: 'Send a notice or letter to a party.',
  },
  'claim.close': {
    domain: 'claims', agentAutonomy: AUTONOMY.PREPARE_FOR_APPROVAL, financial: false,
    description: 'Close the claim.',
  },

  // ── Analyze only (human-originated) ────────────────────────────────────────
  'claim.compensability.deny': {
    domain: 'claims', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: false,
    description: 'Deny the claim or a body part. Licensed-human-only.',
  },
  'medical.rfa.deny_or_modify': {
    domain: 'medical', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: false,
    description: 'Deny or modify requested treatment. Physician reviewer (UR) only.',
  },
  'settlement.authority': {
    domain: 'financial', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: true,
    requiresMfa: true,
    description: 'Grant settlement authority.',
  },
  'settlement.offer': {
    domain: 'litigation', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: true,
    requiresMfa: true,
    description: 'Extend a settlement offer.',
  },
  'claim.reopen': {
    domain: 'claims', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: false,
    description: 'Reopen a closed claim.',
  },
  'litigation.filing': {
    domain: 'litigation', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: false,
    description: 'File or respond to anything before the WCAB.',
  },
  'siu.referral': {
    domain: 'oversight', agentAutonomy: AUTONOMY.ANALYZE_ONLY, financial: false,
    description: 'Refer the claim to special investigations.',
  },
};

for (const [id, action] of Object.entries(ACTIONS)) {
  action.id = id;
  action.requiresMfa = action.requiresMfa === true;
  Object.freeze(action);
}
Object.freeze(ACTIONS);

function getAction(actionId) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, actionId) ? ACTIONS[actionId] : null;
}

/** Public catalog (no functions) for the API and documentation. */
function catalog() {
  return Object.values(ACTIONS).map(a => ({
    id: a.id,
    domain: a.domain,
    description: a.description,
    agent_autonomy: a.agentAutonomy,
    financial: a.financial,
    requires_mfa: a.requiresMfa,
  }));
}

module.exports = { AUTONOMY, ACTIONS, getAction, catalog, PayloadError };
