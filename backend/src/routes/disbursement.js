'use strict';

/**
 * disbursement.js — M14.5 Award Disbursement routes.
 *
 * All routes: requireAuth + requireRole(['admin']) — adjuster-only.
 *
 * Namespace split (matches settlement.js pattern):
 *   /api/v1/claims/:id/…          — claim-scoped (extract, propose, list)
 *   /api/v1/disbursements/:id/…   — disbursement-scoped transitions
 *   /api/v1/pd-advances/:id/…     — per-advance payment + cap override
 *   /api/v1/stipulations/:id/…    — stip award served
 *
 * Error mapping:
 *   'not found'                                           → 404
 *   validation                                            → 400
 *   ADVANCE_CAP_EXCEEDED, CAP_EXCEEDED,
 *   CNR_PAYMENT_ORDER_VIOLATION, DEU_RANGE_EXCEEDED,
 *   WEEKLY_RATE_REQUIRED,
 *   PD_EVALUATION_REQUIRED_BEFORE_ADVANCE                 → 409
 *   anything else                                         → 500
 */

const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const disbursementService               = require('../services/disbursementService');
const awardExtractionService            = require('../services/awardExtractionService');
const pdService                         = require('../services/pdService');

const claimsRouter         = express.Router(); // mounts at /api/v1/claims
const disbursementsRouter  = express.Router(); // mounts at /api/v1/disbursements
const pdAdvancesRouter     = express.Router(); // mounts at /api/v1/pd-advances
const stipulationsRouter   = express.Router(); // mounts at /api/v1/stipulations

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

const CONFLICT_ERRORS = new Set([
  'ADVANCE_CAP_EXCEEDED',
  'CAP_EXCEEDED',
  'CNR_PAYMENT_ORDER_VIOLATION',
  'DEU_RANGE_EXCEEDED',
  'WEEKLY_RATE_REQUIRED',
  'PD_EVALUATION_REQUIRED_BEFORE_ADVANCE',
]);

function mapErrorStatus(err) {
  const msg = err.message || '';
  if (CONFLICT_ERRORS.has(msg)) return 409;
  if (msg.includes('not found')) return 404;
  return 500;
}

// ═════════════════════════════════════════════════════════════════════════════
// Claim-scoped routes
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/v1/claims/:id/extract-award
claimsRouter.post(
  '/:id/extract-award',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('awardType').isIn(['stip_f_and_a', 'cnr_oacr']).withMessage("awardType must be 'stip_f_and_a' or 'cnr_oacr'"),
    body('pdfBase64').isString().notEmpty().withMessage('pdfBase64 is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const pdfBuffer = Buffer.from(req.body.pdfBase64, 'base64');
      const result = await awardExtractionService.extractAward({
        claimId:   req.params.id,
        pdfBuffer,
        awardType: req.body.awardType,
      });
      res.status(201).json({ ...result, documentId: req.body.documentId || null });
    } catch (err) {
      const status = err.message === 'EXTRACTION_FAILED' ? 502 : mapErrorStatus(err);
      res.status(status).json({ error: err.message });
    }
  }
);

// POST /api/v1/claims/:id/propose-disbursement
claimsRouter.post(
  '/:id/propose-disbursement',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('awardType').isIn(['stip_f_and_a', 'cnr_oacr']).withMessage("awardType must be 'stip_f_and_a' or 'cnr_oacr'"),
    body('extraction').isObject().withMessage('extraction is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await disbursementService.proposeDisbursement({
        claimId:             req.params.id,
        awardType:           req.body.awardType,
        stipulationId:       req.body.stipulationId     || null,
        settlementOfferId:   req.body.settlementOfferId || null,
        extraction:          req.body.extraction,
        awardDocumentId:     req.body.awardDocumentId   || null,
      });
      res.status(201).json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// GET /api/v1/claims/:id/disbursements
claimsRouter.get(
  '/:id/disbursements',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const rows = await disbursementService.getDisbursementsForClaim(req.params.id);
      res.json({ disbursements: rows, count: rows.length });
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// Disbursement-scoped routes
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/v1/disbursements/pending
disbursementsRouter.get(
  '/pending',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10);
      const rows = await disbursementService.getPendingDisbursements(
        Number.isFinite(limit) && limit > 0 ? limit : 50,
      );
      res.json({ disbursements: rows, count: rows.length });
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/disbursements/:id/approve
disbursementsRouter.post(
  '/:id/approve',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const row = await disbursementService.approveDisbursement(req.params.id, {
        adjusterId: req.user && req.user.sub ? req.user.sub : null,
        notes:      req.body && req.body.notes ? req.body.notes : null,
      });
      res.json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/disbursements/:id/reject
disbursementsRouter.post(
  '/:id/reject',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('reason').isString().notEmpty().withMessage('reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await disbursementService.rejectDisbursement(req.params.id, {
        adjusterId: req.user && req.user.sub ? req.user.sub : null,
        reason:     req.body.reason,
      });
      res.json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// PATCH /api/v1/disbursements/:id/paid
disbursementsRouter.patch(
  '/:id/paid',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('paidDate').isISO8601().withMessage('paidDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await disbursementService.recordDisbursementPayment(req.params.id, {
        paidDate:  req.body.paidDate,
        reference: req.body.reference || null,
      });
      res.json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// PD-advance-scoped routes
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/v1/pd-advances/:id/record-payment
pdAdvancesRouter.post(
  '/:id/record-payment',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('weekStartDate').isISO8601().withMessage('weekStartDate must be YYYY-MM-DD'),
    body('weekEndDate').isISO8601().withMessage('weekEndDate must be YYYY-MM-DD'),
    body('amountPaid').isFloat({ min: 0.01 }).withMessage('amountPaid must be positive'),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await pdService.recordPDAdvancePayment(req.params.id, {
        weekStartDate: req.body.weekStartDate,
        weekEndDate:   req.body.weekEndDate,
        amountPaid:    parseFloat(req.body.amountPaid),
        paidBy:        req.user && req.user.sub ? req.user.sub : null,
        reference:     req.body.reference || null,
      });
      res.json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// POST /api/v1/pd-advances/:id/override-cap
pdAdvancesRouter.post(
  '/:id/override-cap',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('overridePct').isFloat({ gt: 0, max: 1 }).withMessage('overridePct must be in (0, 1]'),
    body('reason').isString().notEmpty().withMessage('reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await pdService.overrideAdvanceCap(req.params.id, {
        overridePct: parseFloat(req.body.overridePct),
        reason:      req.body.reason,
        overrideBy:  req.user && req.user.sub ? req.user.sub : null,
      });
      res.json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// Stipulation-scoped routes
// ═════════════════════════════════════════════════════════════════════════════

// PATCH /api/v1/stipulations/:id/award-served
stipulationsRouter.patch(
  '/:id/award-served',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('serviceDate').isISO8601().withMessage('serviceDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await pdService.recordStipAwardServed(req.params.id, {
        serviceDate: req.body.serviceDate,
        servedBy:    req.body.servedBy || null,
      });
      res.json(row);
    } catch (err) {
      res.status(mapErrorStatus(err)).json({ error: err.message });
    }
  }
);

module.exports = {
  claimsRouter,
  disbursementsRouter,
  pdAdvancesRouter,
  stipulationsRouter,
};
