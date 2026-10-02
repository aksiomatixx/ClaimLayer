'use strict';

/**
 * financials.js — Routes for Loss-Fund Escrow, Bank Reconciliation, and File QA.
 */

const express = require('express');
const { body, param } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const lossFundService = require('../services/lossFundService');
const fileQaSupervisor = require('../services/fileQaSupervisor');

const router = express.Router();

// ── Loss-Fund Escrow Accounts ────────────────────────────────────────────────
router.post(
  '/loss-funds',
  requireAuth,
  requireRole(['admin', 'supervisor']),
  [
    body('employerId').notEmpty().withMessage('employerId is required'),
    body('accountNumber').notEmpty().withMessage('accountNumber is required'),
    body('initialDeposit').optional().isFloat({ min: 0 }),
    body('minimumThreshold').optional().isFloat({ gt: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const account = await lossFundService.createAccount({
        tenantId: req.user.tenantId,
        actor: { id: req.user.sub || req.user.email, role: req.user.role },
        ...req.body,
      });
      res.status(201).json({ loss_fund_account: account });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.get(
  '/loss-funds/:employerId',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster', 'employer']),
  [param('employerId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const account = await lossFundService.getAccountByEmployer(req.params.employerId);
      if (!account) return res.status(404).json({ error: 'Loss fund account not found for employer' });
      res.json({ loss_fund_account: account });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  '/loss-funds/:id/deposit',
  requireAuth,
  requireRole(['admin', 'supervisor']),
  [
    param('id').notEmpty(),
    body('amount').isFloat({ gt: 0 }).withMessage('Deposit amount must be positive'),
    body('reference').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await lossFundService.recordDeposit(req.params.id, req.body.amount, {
        reference: req.body.reference,
        notes: req.body.notes,
        actor: { id: req.user.sub || req.user.email, role: req.user.role },
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Bank Statement Clearing Reconciliation ────────────────────────────────────
router.post(
  '/reconcile-cleared',
  requireAuth,
  requireRole(['admin', 'supervisor']),
  [
    body('clearedFeed').isArray({ min: 1 }).withMessage('clearedFeed must be a non-empty array'),
  ],
  validate,
  async (req, res) => {
    try {
      const reconciliation = await lossFundService.reconcileClearedPayments(req.body.clearedFeed, {
        actor: { id: req.user.sub || req.user.email, role: req.user.role },
      });
      res.json(reconciliation);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Autonomous File QA Sweep ──────────────────────────────────────────────────
router.post(
  '/qa/sweep',
  requireAuth,
  requireRole(['admin', 'supervisor']),
  async (req, res) => {
    try {
      const report = await fileQaSupervisor.runFileQASweep({ tenantId: req.user.tenantId });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
