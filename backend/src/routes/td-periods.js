'use strict';

/**
 * td-periods.js — TD Period tracking routes.
 *
 * Mounted at /api/v1.
 *
 * All routes require admin role (requireRole(['admin'])) — only the
 * supervising adjuster manages temporary disability periods.
 *
 * NOTE: The full WCIS SROI trigger wiring (IP / CA / CB / Sx / Px /
 * RB / RE / FS) and DWC-9 / SROI 02 generation are deferred to the
 * full tdService milestone. tdPeriodsService methods leave hook
 * comments at the relevant call sites.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const tdPeriodsService                  = require('../services/tdPeriodsService');
const logger                            = require('../logger');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// Map service-thrown errors to HTTP status. Service throws with
// stable substrings so the route can classify without sniffing
// stack traces.
function _statusFor(message) {
  const m = String(message || '');
  if (m.includes('not found') || m.includes('Not found') || m.includes('NOT_FOUND')) return 404;
  if (m === 'PERIOD_ALREADY_CLOSED') return 409;
  if (m === 'UNIQUE_ACTIVE_TD_PERIOD_VIOLATION') return 409;
  if (m.startsWith('CANNOT_REINSTATE_') ||
      m.includes('Cannot reinstate') ||
      m.includes('does not belong to') ||
      m.includes('reinstatement start_date must be after')) return 409;
  if (m.includes('must be') ||
      m.includes('is required') ||
      m.includes('cannot be updated via metadata patch') ||
      m.includes('on or after')) return 400;
  return 500;
}

function _handleError(res, err, where, extra = {}) {
  const status = _statusFor(err.message);
  logger.warn({ msg: `td-periods: ${where} failed`, err: err.message, status, ...extra });
  res.status(status).json({ error: err.message });
}

// ── GET /api/v1/claims/:claimId/td-periods ───────────────────────────────────
router.get(
  '/claims/:claimId/td-periods',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const periods = await tdPeriodsService.listForClaim(req.params.claimId);
      res.json({ periods, count: periods.length });
    } catch (err) {
      _handleError(res, err, 'listForClaim', { claimId: req.params.claimId });
    }
  }
);

// ── GET /api/v1/claims/:claimId/td-summary ───────────────────────────────────
router.get(
  '/claims/:claimId/td-summary',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const summary = await tdPeriodsService.summary(req.params.claimId);
      res.json(summary);
    } catch (err) {
      _handleError(res, err, 'summary', { claimId: req.params.claimId });
    }
  }
);

// ── POST /api/v1/claims/:claimId/td-periods ──────────────────────────────────
router.post(
  '/claims/:claimId/td-periods',
  requireAuth,
  requireRole(['admin']),
  [
    param('claimId').notEmpty(),
    body('benefit_type').isIn(['TTD', 'TPD', 'salary_continuation'])
      .withMessage('benefit_type must be TTD, TPD, or salary_continuation'),
    body('start_date').isISO8601()
      .withMessage('start_date must be YYYY-MM-DD'),
    body('weekly_rate').isFloat({ gt: 0 })
      .withMessage('weekly_rate must be a positive number'),
    body('reason_started').optional().isString(),
    body('notes').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const period = await tdPeriodsService.createPeriod(
        req.params.claimId,
        {
          benefit_type:   req.body.benefit_type,
          start_date:     req.body.start_date,
          weekly_rate:    parseFloat(req.body.weekly_rate),
          reason_started: req.body.reason_started,
          notes:          req.body.notes,
        },
        req.user?.email || null,
      );
      res.status(201).json(period);
    } catch (err) {
      _handleError(res, err, 'createPeriod', { claimId: req.params.claimId });
    }
  }
);

// ── PATCH /api/v1/td-periods/:id/close ───────────────────────────────────────
router.patch(
  '/td-periods/:id/close',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('end_date').isISO8601()
      .withMessage('end_date must be YYYY-MM-DD'),
    body('reason_ended').notEmpty()
      .withMessage('reason_ended is required'),
    body('notes').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const existing = await tdPeriodsService.getById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'TD period not found' });

      const period = await tdPeriodsService.closePeriod(
        req.params.id,
        {
          end_date:     req.body.end_date,
          reason_ended: req.body.reason_ended,
          notes:        req.body.notes,
        },
        req.user?.email || null,
      );
      res.json(period);
    } catch (err) {
      _handleError(res, err, 'closePeriod', { id: req.params.id });
    }
  }
);

// ── PATCH /api/v1/td-periods/:id/reinstate ───────────────────────────────────
// :id is the source (closed) period being reinstated FROM. Service
// signature is reinstatePeriod(claimId, fromPeriodId, input). We
// derive claimId from the source period.
router.patch(
  '/td-periods/:id/reinstate',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('start_date').isISO8601()
      .withMessage('start_date must be YYYY-MM-DD'),
    body('weekly_rate').isFloat({ gt: 0 })
      .withMessage('weekly_rate must be a positive number'),
    body('notes').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const source = await tdPeriodsService.getById(req.params.id);
      if (!source) return res.status(404).json({ error: 'TD period not found' });

      const period = await tdPeriodsService.reinstatePeriod(
        source.claim_id,
        req.params.id,
        {
          start_date:  req.body.start_date,
          weekly_rate: parseFloat(req.body.weekly_rate),
          notes:       req.body.notes,
        },
        req.user?.email || null,
      );
      res.status(201).json(period);
    } catch (err) {
      _handleError(res, err, 'reinstatePeriod', { id: req.params.id });
    }
  }
);

// ── PATCH /api/v1/td-periods/:id (metadata only) ─────────────────────────────
router.patch(
  '/td-periods/:id',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('notes').optional().isString(),
    body('suspension_reason_code').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const existing = await tdPeriodsService.getById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'TD period not found' });

      const period = await tdPeriodsService.updatePeriodMetadata(
        req.params.id,
        {
          notes:                  req.body.notes,
          suspension_reason_code: req.body.suspension_reason_code,
        },
        req.user?.email || null,
      );
      res.json(period);
    } catch (err) {
      _handleError(res, err, 'updatePeriodMetadata', { id: req.params.id });
    }
  }
);

module.exports = router;
