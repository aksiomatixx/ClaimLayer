'use strict';

/**
 * mmi.js — M12 MMI Management + PR-4 Solicitation routes.
 *
 * All routes: requireRole(['admin']) — adjuster-only.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const mmiService                        = require('../services/mmiService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/mmi/evaluate/:claimId — evaluateMMISignals ──────────────────
router.post(
  '/evaluate/:claimId',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const evaluation = await mmiService.evaluateMMISignals(req.params.claimId);
      res.status(201).json(evaluation);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/mmi/:mmiEvaluationId/solicit-pr4 — solicitPR4 ──────────────
router.post(
  '/:mmiEvaluationId/solicit-pr4',
  requireAuth,
  requireRole(['admin']),
  [
    param('mmiEvaluationId').notEmpty(),
    body('claimId').notEmpty().withMessage('claimId is required'),
    body('physicianName').notEmpty().withMessage('physicianName is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const pr4 = await mmiService.solicitPR4(
        req.body.claimId,
        req.params.mmiEvaluationId,
        {
          physicianName:    req.body.physicianName,
          physicianFax:     req.body.physicianFax || null,
          physicianAddress: req.body.physicianAddress || null,
        },
      );
      res.status(201).json(pr4);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/mmi/pr4/:pr4Id/response — recordPR4Response ───────────────
router.patch(
  '/pr4/:pr4Id/response',
  requireAuth,
  requireRole(['admin']),
  [param('pr4Id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await mmiService.recordPR4Response(req.params.pr4Id, {
        wpi:                req.body.wpi,
        workRestrictions:   req.body.workRestrictions || null,
        futureMedical:      req.body.futureMedical || null,
        apportionmentNoted: req.body.apportionmentNoted || false,
      });
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/mmi/:mmiEvaluationId/dismiss — dismissMMIEvaluation ───────
router.patch(
  '/:mmiEvaluationId/dismiss',
  requireAuth,
  requireRole(['admin']),
  [param('mmiEvaluationId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await mmiService.dismissMMIEvaluation(
        req.params.mmiEvaluationId,
        req.user.sub,
        req.body.note || null,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/mmi/claim/:claimId — getMMIEvaluations ──────────────────────
router.get(
  '/claim/:claimId',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const evaluations = await mmiService.getMMIEvaluations(req.params.claimId);
      res.json({ evaluations, count: evaluations.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/mmi/pr4/claim/:claimId — getPR4Solicitations ────────────────
router.get(
  '/pr4/claim/:claimId',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const solicitations = await mmiService.getPR4Solicitations(req.params.claimId);
      res.json({ solicitations, count: solicitations.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
