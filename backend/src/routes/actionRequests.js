'use strict';

/**
 * Action requests — the human approval queue (ADR-0004).
 *
 *   GET  /api/v1/action-registry                 catalog of action types + agent autonomy
 *   POST /api/v1/claims/:id/action-requests      propose (staff); e.g. an adjuster
 *                                                escalating a reserve change above
 *                                                their own authority
 *   GET  /api/v1/claims/:id/action-requests      a claim's requests
 *   GET  /api/v1/action-requests                 the queue (?status=pending_approval)
 *   GET  /api/v1/action-requests/:id             one request
 *   POST /api/v1/action-requests/:id/decision    approve | modify | reject (+ execute)
 *   POST /api/v1/action-requests/:id/execute     retry a failed execution
 *
 * Route roles admit staff only; WHAT a staff member may decide is the
 * authority policy's job, evaluated in approvalService against the amount
 * and the claim. Every query is scoped to the caller's tenant.
 */

const express  = require('express');
const { body, param, query, validationResult } = require('express-validator');
const approvals = require('../services/approvalService');
const { catalog } = require('../policy/actionRegistry');
const { humanPrincipal } = require('../policy/principal');
const { requireAuth, requireRole, STAFF_ROLES } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

const STATUSES = ['pending_approval', 'approved', 'rejected', 'executing',
                  'executed', 'execution_failed', 'cancelled', 'expired'];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

function fail(res, req, err) {
  if (err instanceof approvals.ApprovalError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  logger.error({ msg: 'action-requests: unexpected error', requestId: req.id, err: err.message });
  return res.status(500).json({ error: 'internal_error', requestId: req.id });
}

const staff = [requireAuth, requireRole(STAFF_ROLES)];

router.get('/action-registry', ...staff, (_req, res) => {
  res.json({
    actions: catalog().map(a => ({ ...a, executable: approvals.isExecutable(a.id) })),
  });
});

router.post(
  '/claims/:id/action-requests',
  ...staff,
  [
    param('id').notEmpty(),
    body('action_type').isString().notEmpty(),
    body('payload').isObject(),
    body('rationale').isString(),
    body('evidence').optional().isArray(),
    body('idempotency_key').optional().isString().isLength({ min: 8, max: 200 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { request, idempotent } = await approvals.propose({
        actionType:     req.body.action_type,
        claimId:        req.params.id,
        proposer:       humanPrincipal(req.user),
        payload:        req.body.payload,
        rationale:      req.body.rationale,
        evidence:       req.body.evidence || [],
        idempotencyKey: req.body.idempotency_key || null,
      });
      res.status(idempotent ? 200 : 201).json({ request, idempotent });
    } catch (err) { fail(res, req, err); }
  }
);

router.get(
  '/claims/:id/action-requests',
  ...staff,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const requests = await approvals.listRequests({
        tenantId: humanPrincipal(req.user).tenantId, claimId: req.params.id,
      });
      res.json({ requests });
    } catch (err) { fail(res, req, err); }
  }
);

router.get(
  '/action-requests',
  ...staff,
  [query('status').optional().isIn(STATUSES)],
  validate,
  async (req, res) => {
    try {
      const requests = await approvals.listRequests({
        tenantId: humanPrincipal(req.user).tenantId, status: req.query.status || null,
      });
      res.json({ requests });
    } catch (err) { fail(res, req, err); }
  }
);

router.get(
  '/action-requests/:id',
  ...staff,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      res.json({ request: await approvals.getRequest(req.params.id, humanPrincipal(req.user)) });
    } catch (err) { fail(res, req, err); }
  }
);

router.post(
  '/action-requests/:id/decision',
  ...staff,
  [
    param('id').notEmpty(),
    body('decision').isIn(['approve', 'modify', 'reject']),
    body('rationale').isString(),
    body('payload').optional().isObject(),
  ],
  validate,
  async (req, res) => {
    try {
      const { request } = await approvals.decide(req.params.id, {
        decision:        req.body.decision,
        decider:         humanPrincipal(req.user),
        rationale:       req.body.rationale,
        modifiedPayload: req.body.payload,
      });
      // An approval whose execution failed is recorded (and retryable) but
      // the caller must see that the action did not happen.
      res.status(request.status === 'execution_failed' ? 502 : 200).json({ request });
    } catch (err) { fail(res, req, err); }
  }
);

router.post(
  '/action-requests/:id/execute',
  ...staff,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { request } = await approvals.execute(req.params.id, humanPrincipal(req.user));
      res.status(request.status === 'execution_failed' ? 502 : 200).json({ request });
    } catch (err) { fail(res, req, err); }
  }
);

module.exports = router;
