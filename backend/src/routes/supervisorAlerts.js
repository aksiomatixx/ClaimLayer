'use strict';

/**
 * Supervisor Daily Alert routes (CL-SUP1) — supervisor-role only.
 *
 *   GET  /api/v1/supervisor/alerts/current        — latest digest for the caller
 *   POST /api/v1/supervisor/alerts/:id/acknowledge — ack with audit trail
 *
 * Generation runs through the cron worker (and its admin trigger in
 * routes/admin.js), not through these read endpoints.
 */

const express = require('express');
const { param, validationResult } = require('express-validator');
const alerts = require('../services/supervisorAlertService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

router.get(
  '/supervisor/alerts/current',
  requireAuth, requireRole(['supervisor']),
  async (req, res) => {
    try {
      const alert = await alerts.currentFor(req.user?.email || req.user?.sub);
      res.json({ alert });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

router.post(
  '/supervisor/alerts/:id/acknowledge',
  requireAuth, requireRole(['supervisor']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const alert = await alerts.acknowledge(req.params.id, req.user?.email);
      res.json({ alert });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
