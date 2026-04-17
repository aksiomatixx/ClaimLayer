'use strict';

/**
 * settlement.js — M19 Settlement Foundation routes.
 *
 * All routes: requireRole(['admin']) — adjuster-only.
 */

const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const msaScreeningService               = require('../services/msaScreeningService');
const pdPricingService                   = require('../services/pdPricingService');
const pdService                         = require('../services/pdService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/claims/:id/msa-screen ───────────────────────────────────────
router.post(
  '/:id/msa-screen',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('projectedSettlementValue').isFloat({ min: 0 }).withMessage('projectedSettlementValue required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await msaScreeningService.screenMSA(
        req.params.id,
        parseFloat(req.body.projectedSettlementValue),
      );
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/stip-value ───────────────────────────────────────
router.post(
  '/:id/stip-value',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdService.calculateStipValue(req.params.id);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/cnr-price ────────────────────────────────────────
router.post(
  '/:id/cnr-price',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdPricingService.priceCnr(req.params.id);
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/settlement-offers ─────────────────────────────────
router.get(
  '/:id/settlement-offers',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const offers = await pdPricingService.getSettlementOffers(req.params.id);
      res.json({ offers, count: offers.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
