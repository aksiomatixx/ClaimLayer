'use strict';

/**
 * pd.js — M13 Stipulation + PD Closure + PD Advances routes.
 *
 * All routes: requireRole(['admin']) — adjuster-only.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const pdService                         = require('../services/pdService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/pd/calculate/:claimId — calculatePD ─────────────────────────
router.post(
  '/calculate/:claimId',
  requireAuth,
  requireRole(['admin']),
  [
    param('claimId').notEmpty(),
    body('pr4Id').notEmpty().withMessage('pr4Id is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.calculatePD(req.params.claimId, req.body.pr4Id, {
        apportionmentPercent: req.body.apportionmentPercent || 0,
      });
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/pd/advances/:claimId — initiatePDAdvances ──────────────────
router.post(
  '/advances/:claimId',
  requireAuth,
  requireRole(['admin']),
  [
    param('claimId').notEmpty(),
    body('pdEvaluationId').notEmpty().withMessage('pdEvaluationId is required'),
    body('tdEndDate').isISO8601().withMessage('tdEndDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.initiatePDAdvances(
        req.params.claimId, req.body.pdEvaluationId, { tdEndDate: req.body.tdEndDate },
      );
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/pd/advances/:pdAdvanceId/payment — recordPDAdvancePayment ──
router.patch(
  '/advances/:pdAdvanceId/payment',
  requireAuth,
  requireRole(['admin']),
  [param('pdAdvanceId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.recordPDAdvancePayment(req.params.pdAdvanceId);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/pd/advances/:pdAdvanceId/waive — waivePDAdvance ────────────
router.patch(
  '/advances/:pdAdvanceId/waive',
  requireAuth,
  requireRole(['admin']),
  [
    param('pdAdvanceId').notEmpty(),
    body('reason').notEmpty().withMessage('reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.waivePDAdvance(req.params.pdAdvanceId, req.user.sub, req.body.reason);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/pd/stip/:claimId — createStipulation ───────────────────────
router.post(
  '/stip/:claimId',
  requireAuth,
  requireRole(['admin']),
  [
    param('claimId').notEmpty(),
    body('pdEvaluationId').notEmpty().withMessage('pdEvaluationId is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.createStipulation(req.params.claimId, req.body.pdEvaluationId, {
        futureMedical:      req.body.futureMedical || false,
        futureMedicalDesc:  req.body.futureMedicalDesc || null,
        bodyPartsAccepted:  req.body.bodyPartsAccepted || null,
      });
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/pd/stip/:stipId/send — sendStipToWorker ───────────────────
router.patch(
  '/stip/:stipId/send',
  requireAuth,
  requireRole(['admin']),
  [param('stipId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.sendStipToWorker(req.params.stipId);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/pd/stip/:stipId/worker-signature — recordWorkerSignature ──
router.patch(
  '/stip/:stipId/worker-signature',
  requireAuth,
  requireRole(['admin']),
  [param('stipId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.recordWorkerSignature(req.params.stipId);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/pd/stip/:stipId/adjuster-signature — recordAdjusterSignature
router.patch(
  '/stip/:stipId/adjuster-signature',
  requireAuth,
  requireRole(['admin']),
  [param('stipId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.recordAdjusterSignature(req.params.stipId, req.user.sub);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/pd/stip/:stipId/eams-filed — recordEAMSFiled ──────────────
router.patch(
  '/stip/:stipId/eams-filed',
  requireAuth,
  requireRole(['admin']),
  [
    param('stipId').notEmpty(),
    body('filedDate').isISO8601().withMessage('filedDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.recordEAMSFiled(req.params.stipId, { filedDate: req.body.filedDate });
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/pd/claim/:claimId — combined PD data ────────────────────────
router.get(
  '/claim/:claimId',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const [pdEvaluation, pdAdvances, stipulation] = await Promise.all([
        pdService.getPDEvaluation(req.params.claimId),
        pdService.getPDAdvances(req.params.claimId),
        pdService.getStipulation(req.params.claimId),
      ]);
      res.json({ pdEvaluation, pdAdvances, stipulation });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
