'use strict';

/**
 * Action executors — the ONLY code that turns an approved action request
 * into a state change (ADR-0004).
 *
 * An executor receives the APPROVED payload (which may differ from the
 * proposal, if the approver modified it) and acts as the approving human:
 * every downstream audit record names the person who authorized it, never
 * the agent that proposed it.
 *
 *   precheck(ctx)  optional; runs at proposal and again at decision time so a
 *                  request cannot be approved after the world moved on (e.g.
 *                  the RFA was decided through another path).
 *   execute(ctx)   performs the action; returns a JSON-serializable result.
 *
 * ctx = { tx, request, claimId, payload, approver }
 *
 * execute runs INSIDE the approval's unit of work (ADR-0006): every write
 * goes through ctx.tx, so the action's effects, its ledger entries and the
 * request's 'executed' state commit together — a failure leaves none of
 * them. External systems are reached only through the outbox or a job
 * enqueued on ctx.tx, never called directly from here.
 */

const { fromCents } = require('../utils/money');

class PreconditionError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PRECONDITION_FAILED';
  }
}

const EXECUTORS = {
  'reserve.change': {
    async execute({ tx, request, payload, approver }) {
      const claimService = require('./claimService');
      await claimService.approveReserves(request.claim_id, {
        medical:   fromCents(payload.medical_cents),
        indemnity: fromCents(payload.indemnity_cents),
        expense:   fromCents(payload.expense_cents),
        reason:    payload.reason,
      }, approver.id, { tx, actor: approver, actionRequestId: request.id });
      return {
        medical_cents:   payload.medical_cents,
        indemnity_cents: payload.indemnity_cents,
        expense_cents:   payload.expense_cents,
        total_cents:     payload.medical_cents + payload.indemnity_cents + payload.expense_cents,
      };
    },
  },

  'medical.rfa.approve': {
    async precheck({ claimId, payload }) {
      const rfa = await require('./rfaService').getRFA(payload.rfa_id);
      if (!rfa || rfa.claim_id !== claimId) {
        throw new PreconditionError('RFA not found on this claim');
      }
      if (rfa.decision && rfa.decision !== 'pending_adjuster_review') {
        throw new PreconditionError(`RFA is already decided (${rfa.decision})`);
      }
    },
    async execute({ tx, request, payload, approver }) {
      const rfaService = require('./rfaService');
      // requireUndecided re-checks the precondition under the RFA row lock,
      // so a direct decision racing this approval cannot be overwritten.
      const updated = await rfaService.adjusterApproveRFA(payload.rfa_id, approver.id, {
        tx, actor: approver, requireUndecided: true, actionRequestId: request.id,
      });
      if (!updated) throw new Error('RFA approval did not persist');
      return { rfa_id: payload.rfa_id, decision: updated.decision };
    },
  },
};

function getExecutor(actionId) {
  return Object.prototype.hasOwnProperty.call(EXECUTORS, actionId) ? EXECUTORS[actionId] : null;
}

module.exports = { getExecutor, PreconditionError, EXECUTOR_ACTIONS: Object.keys(EXECUTORS) };
