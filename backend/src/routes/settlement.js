'use strict';

/**
 * settlement.js — M19 Settlement Foundation + M14 C&R workflow.
 *
 * All routes: requireRole(['admin']) — adjuster-only.
 *
 * Namespace split:
 *   /api/v1/claims/:id/...    — claim-scoped reads (compare-offers, list offers)
 *   /api/v1/offers/:offerId/… — offer-scoped transitions (M14 C&R workflow).
 *     A claim may have multiple C&R offers across its life, so state
 *     transitions bind to the offer, not the claim.
 *
 * Error conventions:
 *   'not found'                              → 404
 *   validation failures                      → 400
 *   'CNR_BLOCKED_' / 'MSA_SCREENING_REQUIRED_' prefix → 409 Conflict
 *   everything else                          → 500
 *
 * The /api/v1/offers router is wired up in src/index.js alongside this file.
 */

const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const msaScreeningService               = require('../services/msaScreeningService');
const pdPricingService                  = require('../services/pdPricingService');
const pdService                         = require('../services/pdService');
const cnrService                        = require('../services/cnrService');

const router       = express.Router(); // claim-scoped routes
const offersRouter = express.Router(); // offer-scoped routes

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

function mapErrorStatus(err) {
  const msg = err.message || '';
  if (msg.startsWith('CNR_BLOCKED_') || msg.startsWith('MSA_SCREENING_REQUIRED_')) return 409;
  if (msg.includes('not found')) return 404;
  if (msg.startsWith('Invalid C&R transition') || msg === 'C&R_FORM_TEMPLATE_NOT_PROVIDED') return 409;
  return 500;
}

// ═════════════════════════════════════════════════════════════════════════════
// Claim-scoped routes (M19 + M14 compare)
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/v1/claims/:id/msa-screen
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
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/claims/:id/stip-value
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
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/claims/:id/cnr-price
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
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// GET /api/v1/claims/:id/settlement-offers
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

// GET /api/v1/claims/:id/compare-offers  (M14)
router.get(
  '/:id/compare-offers',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await pdPricingService.compareOffers(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// Offer-scoped routes (M14)
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/v1/offers/:offerId/offer
offersRouter.post(
  '/:offerId/offer',
  requireAuth,
  requireRole(['admin']),
  [
    param('offerId').notEmpty(),
    body('offeredTo').isIn(['worker', 'attorney']).withMessage("offeredTo must be 'worker' or 'attorney'"),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.offerCnr(req.params.offerId, { offeredTo: req.body.offeredTo });
      res.status(200).json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/offers/:offerId/worker-accept
offersRouter.post(
  '/:offerId/worker-accept',
  requireAuth,
  requireRole(['admin']),
  [param('offerId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.recordWorkerAcceptance(req.params.offerId);
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/offers/:offerId/adjuster-sign
offersRouter.post(
  '/:offerId/adjuster-sign',
  requireAuth,
  requireRole(['admin']),
  [param('offerId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.recordAdjusterSignature(req.params.offerId, req.user.sub);
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// PATCH /api/v1/offers/:offerId/eams-filed
offersRouter.patch(
  '/:offerId/eams-filed',
  requireAuth,
  requireRole(['admin']),
  [
    param('offerId').notEmpty(),
    body('filedDate').isISO8601().withMessage('filedDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.recordEAMSFiled(req.params.offerId, {
        filedDate: req.body.filedDate,
        filedBy:   req.user.sub,
      });
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// PATCH /api/v1/offers/:offerId/oacr-received
offersRouter.patch(
  '/:offerId/oacr-received',
  requireAuth,
  requireRole(['admin']),
  [
    param('offerId').notEmpty(),
    body('oacrDate').isISO8601().withMessage('oacrDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.recordOACRReceived(req.params.offerId, { oacrDate: req.body.oacrDate });
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// PATCH /api/v1/offers/:offerId/paid
offersRouter.patch(
  '/:offerId/paid',
  requireAuth,
  requireRole(['admin']),
  [
    param('offerId').notEmpty(),
    body('paidDate').isISO8601().withMessage('paidDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.recordPayment(req.params.offerId, { paidDate: req.body.paidDate });
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/offers/:offerId/reject
offersRouter.post(
  '/:offerId/reject',
  requireAuth,
  requireRole(['admin']),
  [
    param('offerId').notEmpty(),
    body('reason').isString().notEmpty().withMessage('reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.rejectOffer(req.params.offerId, { reason: req.body.reason });
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/offers/:offerId/withdraw
offersRouter.post(
  '/:offerId/withdraw',
  requireAuth,
  requireRole(['admin']),
  [
    param('offerId').notEmpty(),
    body('reason').isString().notEmpty().withMessage('reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.withdrawOffer(req.params.offerId, { reason: req.body.reason });
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// GET /api/v1/offers/:offerId/timeline
offersRouter.get(
  '/:offerId/timeline',
  requireAuth,
  requireRole(['admin']),
  [param('offerId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await cnrService.getOfferWithTimeline(req.params.offerId);
      res.json(result);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// GET /api/v1/offers/:offerId/document
// Will return 409 with 'C&R_FORM_TEMPLATE_NOT_PROVIDED' until DWC-CA form
// 10214(c) is supplied and generateCnrDocument is implemented.
offersRouter.get(
  '/:offerId/document',
  requireAuth,
  requireRole(['admin']),
  [param('offerId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const buf = await cnrService.generateCnrDocument(req.params.offerId);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(buf);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

module.exports = router;
module.exports.offersRouter = offersRouter;
