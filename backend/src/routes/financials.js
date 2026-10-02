'use strict';

/**
 * financials.js — Routes for Loss-Fund Escrow, Bank Reconciliation, and File QA.
 */

const express = require('express');
const { body, param } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { humanPrincipal } = require('../policy/principal');
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
      // Only the documented fields: the tenant and the actor come from the
      // session, never from the request body.
      const actor = humanPrincipal(req.user);
      const account = await lossFundService.createAccount({
        tenantId:                  actor.tenantId,
        employerId:                req.body.employerId,
        accountNumber:             req.body.accountNumber,
        bankName:                  req.body.bankName,
        initialDeposit:            req.body.initialDeposit,
        minimumThreshold:          req.body.minimumThreshold,
        targetReplenishmentAmount: req.body.targetReplenishmentAmount,
      }, { actor });
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
      // An employer user sees only its own employer's account; staff only
      // their own tenant's.
      if (req.user.role === 'employer' && req.params.employerId !== (req.user.employerId || req.user.sub)) {
        return res.status(404).json({ error: 'Loss fund account not found for employer' });
      }
      const account = await lossFundService.getAccountByEmployer(req.params.employerId, {
        tenantId: humanPrincipal(req.user).tenantId,
      });
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
      const actor = humanPrincipal(req.user);
      const result = await lossFundService.recordDeposit(req.params.id, req.body.amount, {
        reference: req.body.reference,
        notes: req.body.notes,
        actor,
      }, { tenantId: actor.tenantId });
      res.json(result);
    } catch (err) {
      if (/not found/.test(err.message)) return res.status(404).json({ error: err.message });
      if (/is closed/.test(err.message)) return res.status(409).json({ error: err.message });
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
      const actor = humanPrincipal(req.user);
      const reconciliation = await lossFundService.reconcileClearedPayments(req.body.clearedFeed, {
        actor,
      }, { tenantId: actor.tenantId });
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
