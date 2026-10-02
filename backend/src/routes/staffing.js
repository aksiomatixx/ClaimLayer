'use strict';

/**
 * staffing.js — Routes for Staffing Industry Hierarchy & Client Loss Runs.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { requireClaimScope } = require('../middleware/claimAccess');
const { humanPrincipal } = require('../policy/principal');

// Staff only. Employer-portal users are scoped to their own employer's claims;
// there is no mapping yet from an employer user to an agency or host employer,
// so the staffing hierarchy and client loss runs are not exposed to them.
const STAFF = ['admin', 'supervisor', 'adjuster'];
const tenantOf = (req) => humanPrincipal(req.user).tenantId;
const staffingService = require('../services/staffingService');

const router = express.Router();

// ── Agencies ─────────────────────────────────────────────────────────────────
router.get(
  '/agencies',
  requireAuth,
  requireRole(STAFF),
  async (req, res) => {
    try {
      const agencies = await staffingService.listAgencies({ tenantId: tenantOf(req) });
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
      // Only the documented fields; the tenant comes from the session.
      const agency = await staffingService.createAgency({
        tenantId:      tenantOf(req),
        name:          req.body.name,
        fein:          req.body.fein,
        licenseNumber: req.body.licenseNumber,
        contactEmail:  req.body.contactEmail,
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
  requireRole(STAFF),
  async (req, res) => {
    try {
      const employers = await staffingService.listHostEmployers({
        tenantId: tenantOf(req),
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
        tenantId:        tenantOf(req),
        agencyId:        req.body.agencyId,
        name:            req.body.name,
        industryNaics:   req.body.industryNaics,
        worksiteAddress: req.body.worksiteAddress,
        city:            req.body.city,
        state:           req.body.state,
        zipCode:         req.body.zipCode,
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
  requireRole(STAFF),
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
        tenantId: tenantOf(req),
      });
      res.json(lossRun);
    } catch (err) {
      if (/not found/.test(err.message)) return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Client Assignments ────────────────────────────────────────────────────────
router.post(
  '/assignments',
  requireAuth,
  requireRole(STAFF),
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
        tenantId:       tenantOf(req),
        agencyId:       req.body.agencyId,
        hostEmployerId: req.body.hostEmployerId,
        employeeId:     req.body.employeeId,
        jobTitle:       req.body.jobTitle,
        classCode:      req.body.classCode,
        hourlyWage:     req.body.hourlyWage,
        startDate:      req.body.startDate,
        endDate:        req.body.endDate,
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
  requireRole(STAFF),
  requireClaimScope('params.id'),
  [
    param('id').notEmpty(),
    body('bodyPartCode').notEmpty().withMessage('bodyPartCode is required'),
    body('bodyPartName').notEmpty().withMessage('bodyPartName is required'),
    body('side').optional().isIn(['left', 'right', 'bilateral', 'na']),
  ],
  validate,
  async (req, res) => {
    try {
      // The claim is the path's (scope-checked above), never the body's.
      const row = await staffingService.addClaimBodyPart({
        tenantId:     tenantOf(req),
        claimId:      req.params.id,
        bodyPartCode: req.body.bodyPartCode,
        bodyPartName: req.body.bodyPartName,
        side:         req.body.side,
      });
      res.status(201).json({ body_part: row });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
