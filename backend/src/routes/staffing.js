'use strict';

/**
 * staffing.js — Routes for Staffing Industry Hierarchy & Client Loss Runs.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const staffingService = require('../services/staffingService');

const router = express.Router();

// ── Agencies ─────────────────────────────────────────────────────────────────
router.get(
  '/agencies',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster', 'employer']),
  async (req, res) => {
    try {
      const agencies = await staffingService.listAgencies({ tenantId: req.user.tenantId });
      res.json({ agencies });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  '/agencies',
  requireAuth,
  requireRole(['admin', 'supervisor']),
  [
    body('name').notEmpty().withMessage('Agency name is required'),
    body('fein').optional().isString(),
    body('licenseNumber').optional().isString(),
    body('contactEmail').optional().isEmail(),
  ],
  validate,
  async (req, res) => {
    try {
      const agency = await staffingService.createAgency({
        tenantId: req.user.tenantId,
        ...req.body,
      });
      res.status(201).json({ agency });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Host Employers (Clients) ──────────────────────────────────────────────────
router.get(
  '/host-employers',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster', 'employer']),
  async (req, res) => {
    try {
      const employers = await staffingService.listHostEmployers({
        tenantId: req.user.tenantId,
        agencyId: req.query.agencyId,
      });
      res.json({ host_employers: employers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  '/host-employers',
  requireAuth,
  requireRole(['admin', 'supervisor']),
  [
    body('agencyId').notEmpty().withMessage('agencyId is required'),
    body('name').notEmpty().withMessage('Host employer name is required'),
    body('industryNaics').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const employer = await staffingService.createHostEmployer({
        tenantId: req.user.tenantId,
        ...req.body,
      });
      res.status(201).json({ host_employer: employer });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Client Loss Run ───────────────────────────────────────────────────────────
router.get(
  '/host-employers/:id/loss-run',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster', 'employer']),
  [
    param('id').notEmpty(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
  ],
  validate,
  async (req, res) => {
    try {
      const lossRun = await staffingService.getClientLossRun({
        hostEmployerId: req.params.id,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        tenantId: req.user.tenantId,
      });
      res.json(lossRun);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Client Assignments ────────────────────────────────────────────────────────
router.post(
  '/assignments',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster', 'employer']),
  [
    body('agencyId').notEmpty().withMessage('agencyId is required'),
    body('hostEmployerId').notEmpty().withMessage('hostEmployerId is required'),
    body('employeeId').notEmpty().withMessage('employeeId is required'),
    body('startDate').isISO8601().withMessage('startDate must be an ISO date'),
    body('hourlyWage').optional().isFloat({ gt: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const assignment = await staffingService.createAssignment({
        tenantId: req.user.tenantId,
        ...req.body,
      });
      res.status(201).json({ assignment });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Claim Body Parts ──────────────────────────────────────────────────────────
router.post(
  '/claims/:id/body-parts',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster']),
  [
    param('id').notEmpty(),
    body('bodyPartCode').notEmpty().withMessage('bodyPartCode is required'),
    body('bodyPartName').notEmpty().withMessage('bodyPartName is required'),
    body('side').optional().isIn(['left', 'right', 'bilateral', 'na']),
  ],
  validate,
  async (req, res) => {
    try {
      const row = await staffingService.addClaimBodyPart({
        tenantId: req.user.tenantId,
        claimId: req.params.id,
        ...req.body,
      });
      res.status(201).json({ body_part: row });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
