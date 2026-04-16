'use strict';

/**
 * reporting.js — M10 Reporting API routes.
 *
 * Employer endpoints (employer + admin):
 *   GET /api/v1/employers/:id/loss-run              — loss run for employer
 *   GET /api/v1/employers/:id/summary               — aggregate stats
 *   GET /api/v1/employers/:id/experience-mod-inputs  — e-mod raw data
 *
 * Admin-only endpoints:
 *   GET /api/v1/reports/cross-employer               — all employers overview
 *   GET /api/v1/reports/missed-deadlines             — compliance violations
 */

const express = require('express');
const { param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const reportingService = require('../services/reportingService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── Employer scope check ─────────────────────────────────────────────────────
// Employers can only access their own data. Admins can access any employer.
function enforceEmployerScope(req, res, next) {
  const requestedId = req.params.id;

  if (req.user.role === 'employer') {
    const ownId = req.user.employerId || req.user.sub;
    if (requestedId !== ownId) {
      return res.status(403).json({ error: 'Access denied — employers can only view their own data' });
    }
  }
  next();
}

// ── GET /api/v1/employers/:id/loss-run ───────────────────────────────────────
router.get(
  '/employers/:id/loss-run',
  requireAuth,
  requireRole(['admin', 'employer']),
  [param('id').notEmpty()],
  validate,
  enforceEmployerScope,
  async (req, res) => {
    try {
      const lossRun = await reportingService.getLossRun(req.params.id);
      res.json({ lossRun, count: lossRun.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/employers/:id/summary ────────────────────────────────────────
router.get(
  '/employers/:id/summary',
  requireAuth,
  requireRole(['admin', 'employer']),
  [param('id').notEmpty()],
  validate,
  enforceEmployerScope,
  async (req, res) => {
    try {
      const summary = await reportingService.getEmployerSummary(req.params.id);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/employers/:id/experience-mod-inputs ──────────────────────────
router.get(
  '/employers/:id/experience-mod-inputs',
  requireAuth,
  requireRole(['admin', 'employer']),
  [param('id').notEmpty()],
  validate,
  enforceEmployerScope,
  async (req, res) => {
    try {
      const inputs = await reportingService.getExperienceModInputs(req.params.id);
      res.json(inputs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/reports/cross-employer ────────────────────────────────────────
router.get(
  '/reports/cross-employer',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const report = await reportingService.getCrossEmployerReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/reports/missed-deadlines ─────────────────────────────────────
router.get(
  '/reports/missed-deadlines',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const report = await reportingService.getMissedDeadlineReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
