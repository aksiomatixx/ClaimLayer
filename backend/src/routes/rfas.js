'use strict';

const express                    = require('express');
const { body, param, query, validationResult } = require('express-validator');
const rfaService                 = require('../services/rfaService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// ── POST /api/v1/rfas — Create RFA (admin/adjuster only) ──────────────────────
router.post(
  '/',
  requireAuth,
  requireRole(['admin', 'adjuster']),
  [
    body('claimId').notEmpty().withMessage('claimId is required'),
    body('treatmentDescription').notEmpty().withMessage('treatmentDescription is required'),
    body('cptCodes').optional().isArray().withMessage('cptCodes must be an array'),
    body('urgency')
      .optional()
      .isIn(['standard', 'expedited'])
      .withMessage('urgency must be standard or expedited'),
  ],
  validate,
  async (req, res) => {
    try {
      const { claimId, receivedVia, ...rfaData } = req.body;
      const rfa = await rfaService.createRFA(claimId, rfaData, receivedVia || 'portal');
      res.status(201).json(rfa);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/rfas — List RFAs ─────────────────────────────────────────────
// ?claimId=xxx              — list for a specific claim (any authenticated user)
// ?status=pending_adjuster_review — list by status (admin/adjuster only)
// At least one filter is required.
router.get(
  '/',
  requireAuth,
  async (req, res) => {
    const { claimId, status } = req.query;

    if (!claimId && !status) {
      return res.status(400).json({
        error: 'Validation failed',
        details: [{ msg: 'claimId or status query parameter is required' }],
      });
    }

    // Status-only queries require admin or adjuster role
    if (status && !claimId && !['admin', 'adjuster'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Role not permitted for this query' });
    }

    try {
      const rfas = await rfaService.listRFAs({ claimId, status });
      res.json({ rfas, count: rfas.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/rfas/:id — Get single RFA with evaluation ────────────────────
router.get(
  '/:id',
  requireAuth,
  [param('id').notEmpty().withMessage('id is required')],
  validate,
  async (req, res) => {
    try {
      const rfa = await rfaService.getRFA(req.params.id);
      if (!rfa) return res.status(404).json({ error: 'RFA not found' });
      res.json(rfa);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/rfas/:id/approve — Adjuster approve ─────────────────────────
router.post(
  '/:id/approve',
  requireAuth,
  requireRole(['admin', 'adjuster']),
  [param('id').notEmpty().withMessage('id is required')],
  validate,
  async (req, res) => {
    try {
      const adjusterEmail = req.user.email || req.user.sub;
      const rfa = await rfaService.adjusterApproveRFA(req.params.id, adjusterEmail);
      if (!rfa) return res.status(404).json({ error: 'RFA not found' });
      res.json(rfa);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/rfas/:id/route-to-uro — Adjuster escalate to URO ────────────
router.post(
  '/:id/route-to-uro',
  requireAuth,
  requireRole(['admin', 'adjuster']),
  [
    param('id').notEmpty().withMessage('id is required'),
    body('reason').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const adjusterEmail = req.user.email || req.user.sub;
      const rfa = await rfaService.adjusterRouteToURO(req.params.id, adjusterEmail, req.body.reason);
      if (!rfa) return res.status(404).json({ error: 'RFA not found' });
      res.json(rfa);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
