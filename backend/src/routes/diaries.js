'use strict';

/**
 * Aftermath Automation routes (admin-only).
 *
 *   GET  /api/v1/diaries/:id/aftermath-preview — what completing will do
 *   POST /api/v1/diaries/:id/complete          — complete + run the aftermath
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const diaryActionService = require('../services/diaryActionService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

router.get(
  '/diaries/:id/aftermath-preview',
  requireAuth, requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      res.json(await diaryActionService.previewAftermath(req.params.id));
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

router.post(
  '/diaries/:id/complete',
  requireAuth, requireRole(['admin']),
  [param('id').notEmpty(), body('action').optional().isString()],
  validate,
  async (req, res) => {
    try {
      const result = await diaryActionService.completeAction(
        req.params.id, { action: req.body.action, note: req.body.note }, req.user?.email);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
