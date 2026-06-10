'use strict';

const express              = require('express');
const { body, param, validationResult } = require('express-validator');
const appointmentService   = require('../services/appointmentService');
const db                   = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireClaimScope } = require('../middleware/claimAccess');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/appointments — book an appointment ───────────────────────────
router.post(
  '/',
  requireAuth,
  requireRole(['employee', 'admin']),
  requireClaimScope('body.claim_id'),
  [
    body('claim_id').notEmpty().withMessage('claim_id is required'),
    body('provider_id').notEmpty().withMessage('provider_id is required'),
    body('appointment_type')
      .optional()
      .isIn(['initial_eval', 'follow_up', 'specialist', 'pt', 'urgent_care'])
      .withMessage('Invalid appointment_type'),
    body('scheduled_at')
      .optional()
      .isISO8601().withMessage('scheduled_at must be a valid ISO date'),
  ],
  validate,
  async (req, res) => {
    try {
      const appointment = await appointmentService.createAppointment({
        claimId:         req.body.claim_id,
        providerId:      req.body.provider_id,
        appointmentType: req.body.appointment_type || 'initial_eval',
        scheduledAt:     req.body.scheduled_at,
        bookedByUserId:  req.user.sub,
      });
      res.status(201).json({ appointment });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/appointments/:id/mpn-acknowledge — log MPN acknowledgment ───
router.post(
  '/:claimId/mpn-acknowledge',
  requireAuth,
  requireRole(['employee', 'admin']),
  requireClaimScope('params.claimId'),
  [param('claimId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      await appointmentService.logMpnAcknowledgment(
        req.params.claimId,
        req.user.sub
      );
      res.json({ acknowledged: true, claimId: req.params.claimId, logged_at: new Date().toISOString() });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/appointments/:id/confirm — enter confirmation number ────────
router.patch(
  '/:id/confirm',
  requireAuth,
  requireRole(['employee', 'admin']),
  // The claim hangs off the appointment — resolve it, then scope-check.
  requireClaimScope(async (req) => {
    const appt = await db.appointments.findById(req.params.id);
    return appt ? appt.claim_id : null;
  }),
  [
    param('id').notEmpty(),
    body('confirmation_number')
      .notEmpty().withMessage('confirmation_number is required')
      .isLength({ min: 3, max: 100 }).withMessage('confirmation_number must be 3–100 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const appointment = await appointmentService.confirmAppointment(
        req.params.id,
        req.body.confirmation_number
      );
      res.json({ appointment });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
