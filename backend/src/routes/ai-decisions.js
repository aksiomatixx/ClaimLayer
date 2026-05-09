'use strict';

/**
 * ai-decisions.js — admin "Agents" feed routes.
 *
 * Mounted at /api/v1. All routes require admin role.
 *
 *   GET /ai-decisions          — paginated, filterable feed
 *   GET /ai-decisions/stats    — KPI cards (window=N days)
 *   GET /ai-decisions/:id      — single row
 *   GET /prompts/:name         — read-only prompt text (path-traversal guarded)
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { param, query, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const aiDecisionsService           = require('../services/aiDecisionsService');
const logger                       = require('../logger');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// ── GET /api/v1/ai-decisions/stats ───────────────────────────────────────────
// Mounted before /:id so 'stats' is not interpreted as an :id value.
router.get(
  '/ai-decisions/stats',
  requireAuth,
  requireRole(['admin']),
  [query('window').optional().isInt({ min: 1, max: 365 })],
  validate,
  async (req, res) => {
    try {
      const windowDays = req.query.window ? parseInt(req.query.window, 10) : 30;
      const out = await aiDecisionsService.stats({ windowDays });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/ai-decisions ─────────────────────────────────────────────────
router.get(
  '/ai-decisions',
  requireAuth,
  requireRole(['admin']),
  [
    query('claimId').optional().isString(),
    query('decision_type').optional().isIn([
      'compensability', 'rfa_mtus', 'cnr_pricing', 'msa_screening', 'voice_extract',
    ]),
    query('hasOverride').optional().isBoolean(),
    query('guardrailTriggered').optional().isBoolean(),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  async (req, res) => {
    try {
      const opts = {
        claimId:            req.query.claimId,
        decision_type:      req.query.decision_type,
        dateFrom:           req.query.dateFrom,
        dateTo:             req.query.dateTo,
        hasOverride:        req.query.hasOverride === undefined ? undefined : req.query.hasOverride === 'true',
        guardrailTriggered: req.query.guardrailTriggered === undefined ? undefined : req.query.guardrailTriggered === 'true',
        limit:              req.query.limit ? parseInt(req.query.limit, 10) : 50,
        offset:             req.query.offset ? parseInt(req.query.offset, 10) : 0,
      };
      const out = await aiDecisionsService.listDecisions(opts);
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/ai-decisions/:id ─────────────────────────────────────────────
router.get(
  '/ai-decisions/:id',
  requireAuth,
  requireRole(['admin']),
  [param('id').isUUID().withMessage('id must be a UUID')],
  validate,
  async (req, res) => {
    try {
      const row = await aiDecisionsService.getDecision(req.params.id);
      if (!row) return res.status(404).json({ error: 'Decision not found' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/prompts/:name ────────────────────────────────────────────────
//
// Returns the raw text of a prompt file. Used by the Agents view's
// "View prompt" modal so reviewers can inspect what the model is
// being told for any decision_type.
//
// Security: name must match /^[a-z0-9_]+$/ — no '..', '/', or other
// path-traversal characters. The resolved file must also live inside
// PROMPTS_DIR (defense in depth).
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const SAFE_NAME   = /^[a-z0-9_]+$/;

router.get(
  '/prompts/:name',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    const name = req.params.name;
    if (!name || !SAFE_NAME.test(name)) {
      return res.status(400).json({ error: 'Invalid prompt name' });
    }
    const filePath = path.join(PROMPTS_DIR, `${name}.txt`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(PROMPTS_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid prompt path' });
    }
    try {
      const text = fs.readFileSync(resolved, 'utf8');
      res.json({ name, text });
    } catch (err) {
      logger.warn({ msg: 'prompts: read failed', name, err: err.message });
      res.status(404).json({ error: 'Prompt not found' });
    }
  }
);

module.exports = router;
