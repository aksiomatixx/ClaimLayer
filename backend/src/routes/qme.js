'use strict';

/**
 * qme.js — M11 QME/AME Process Management routes.
 *
 * All routes: requireRole(['admin']) — only adjusters manage QME/AME panels.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole }      = require('../middleware/auth');
const qmeService                        = require('../services/qmeService');
const supplementalRequestService        = require('../services/supplementalRequestService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/qme — requestPanel ─────────────────────────────────────────
router.post(
  '/',
  requireAuth,
  requireRole(['admin']),
  [
    body('claimId').notEmpty().withMessage('claimId is required'),
    body('specialty').notEmpty().withMessage('specialty is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const panel = await qmeService.requestPanel(
        req.body.claimId,
        req.body.specialty,
        req.body.adjusterNotes || null,
      );
      res.status(201).json(panel);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/qme/claim/:claimId — getPanelsForClaim ──────────────────────
router.get(
  '/claim/:claimId',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const panels = await qmeService.getPanelsForClaim(req.params.claimId);
      res.json({ panels, count: panels.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/qme/:id — getPanel ──────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const panel = await qmeService.getPanel(req.params.id);
      if (!panel) return res.status(404).json({ error: 'QME panel not found' });
      res.json(panel);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/qme/:id/issue — issuePanel ────────────────────────────────
router.patch(
  '/:id/issue',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('panelIssuedDate').isISO8601().withMessage('panelIssuedDate must be YYYY-MM-DD'),
    body('doctor1.name').notEmpty().withMessage('doctor1.name is required'),
    body('doctor1.npi').notEmpty().withMessage('doctor1.npi is required'),
    body('doctor2.name').notEmpty().withMessage('doctor2.name is required'),
    body('doctor2.npi').notEmpty().withMessage('doctor2.npi is required'),
    body('doctor3.name').notEmpty().withMessage('doctor3.name is required'),
    body('doctor3.npi').notEmpty().withMessage('doctor3.npi is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const panel = await qmeService.issuePanel(req.params.id, {
        panelIssuedDate: req.body.panelIssuedDate,
        doctor1: req.body.doctor1,
        doctor2: req.body.doctor2,
        doctor3: req.body.doctor3,
      });
      res.json(panel);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/qme/:id/strikes — recordStrikes ───────────────────────────
router.patch(
  '/:id/strikes',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('strike1Npi').notEmpty().withMessage('strike1Npi is required'),
    body('strike2Npi').notEmpty().withMessage('strike2Npi is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const panel = await qmeService.recordStrikes(req.params.id, {
        strike1Npi: req.body.strike1Npi,
        strike2Npi: req.body.strike2Npi,
      });
      res.json(panel);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/qme/:id/appointment — scheduleAppointment ─────────────────
router.patch(
  '/:id/appointment',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('appointmentDate').isISO8601().withMessage('appointmentDate must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res) => {
    try {
      const panel = await qmeService.scheduleAppointment(req.params.id, {
        appointmentDate: req.body.appointmentDate,
      });
      res.json(panel);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/qme/:id/report-received — recordReportReceived ────────────
router.patch(
  '/:id/report-received',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const panel = await qmeService.recordReportReceived(req.params.id);
      res.json(panel);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── Supplemental requests ────────────────────────────────────────────────────

// GET /api/v1/qme/supplementals/:claimId
router.get(
  '/supplementals/:claimId',
  requireAuth,
  requireRole(['admin']),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const requests = await supplementalRequestService.getSupplementalRequests(req.params.claimId);
      res.json({ supplementalRequests: requests, count: requests.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH /api/v1/qme/supplementals/:id/approve
router.patch(
  '/supplementals/:id/approve',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await supplementalRequestService.approveAndSend(req.params.id, req.user.sub);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// PATCH /api/v1/qme/supplementals/:id/dismiss
router.patch(
  '/supplementals/:id/dismiss',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('reason').notEmpty().withMessage('reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await supplementalRequestService.dismiss(req.params.id, req.user.sub, req.body.reason);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
