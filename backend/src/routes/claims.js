'use strict';

const express           = require('express');
const { body, param, query, validationResult } = require('express-validator');
const claimService      = require('../services/claimService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Validation helper ─────────────────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// ── POST /api/v1/claims — Submit FROI / create new claim ──────────────────────
router.post(
  '/',
  requireAuth,
  requireRole(['admin', 'employer']),
  [
    body('adpEmployeeId')
      .notEmpty().withMessage('adpEmployeeId is required'),
    body('employerName')
      .notEmpty().withMessage('employerName is required'),
    body('dateOfInjury')
      .isISO8601().withMessage('dateOfInjury must be a valid date (YYYY-MM-DD)'),
    body('bodyPart')
      .notEmpty().withMessage('bodyPart is required'),
    body('injuryType')
      .notEmpty().withMessage('injuryType is required'),
    body('injuryDescription')
      .isLength({ min: 10 }).withMessage('injuryDescription must be at least 10 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.createClaim(req.body, req.user.employerId || req.user.sub);
      res.status(201).json(claim);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims — List claims ─────────────────────────────────────────
router.get(
  '/',
  requireAuth,
  [
    query('status')
      .optional()
      .isIn([
        'new_claim', 'intake_complete', 'under_investigation', 'accepted',
        'active_medical', 'p_and_s', 'pd_evaluation',
        'settlement_discussions', 'litigated', 'denied', 'closed',
      ])
      .withMessage('Invalid status value'),
  ],
  validate,
  async (req, res) => {
    try {
      const filters = {};

      // Employers only see their own claims; admins can see all or filter by employerId
      if (req.user.role === 'employer') {
        filters.employerId = req.user.employerId || req.user.sub;
      } else if (req.query.employerId) {
        filters.employerId = req.query.employerId;
      }

      if (req.query.status) filters.status = req.query.status;

      const claims = await claimService.listClaims(filters);
      res.json({ claims, count: claims.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id — Get single claim ─────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      // Employers may only view their own claims
      if (req.user.role === 'employer') {
        const empId = req.user.employerId || req.user.sub;
        if (claim.employerId !== empId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      res.json(claim);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/claims/:id/reserves — Adjuster approves reserves ────────────
router.patch(
  '/:id/reserves',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('medical')
      .isFloat({ min: 0 }).withMessage('medical reserve must be a non-negative number'),
    body('indemnity')
      .isFloat({ min: 0 }).withMessage('indemnity reserve must be a non-negative number'),
    body('expense')
      .isFloat({ min: 0 }).withMessage('expense reserve must be a non-negative number'),
    body('reason')
      .optional()
      .isLength({ min: 3 }).withMessage('reason must be at least 3 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.approveReserves(
        req.params.id,
        {
          medical:   parseFloat(req.body.medical),
          indemnity: parseFloat(req.body.indemnity),
          expense:   parseFloat(req.body.expense),
          reason:    req.body.reason,
        },
        req.user.email
      );
      res.json(claim);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/claims/:id/status — Update claim status ────────────────────
router.patch(
  '/:id/status',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('status')
      .isIn([
        'intake_complete', 'under_investigation', 'accepted',
        'active_medical', 'p_and_s', 'pd_evaluation',
        'settlement_discussions', 'litigated', 'denied', 'closed',
      ])
      .withMessage('Invalid target status'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.updateStatus(
        req.params.id,
        req.body.status,
        req.user.email
      );
      res.json(claim);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
