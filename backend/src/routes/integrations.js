'use strict';

/**
 * integrations.js — admin Integrations console routes.
 *
 * Mounted at /api/v1. All routes require admin role.
 *
 *   GET  /integrations/systems
 *     → [{ system, label, role, direction, health, claim_count }]
 *   POST /integrations/:system/migrate
 *     → runs legacyMigrationService.migrateFromLegacy
 *   GET  /integrations/migrated
 *     → claims with source_system <> 'native'
 *   GET  /integrations/:system/legacy-record/:externalId
 *     → legacy_* rows for one external claim (so the demo can show what
 *       was pushed back to the legacy system)
 *
 * All endpoints return JSON. Errors come back as { error: string } with
 * 4xx / 5xx status — matches the convention used by ai-decisions.js.
 */

const express = require('express');
const { param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getAdapter, SYSTEMS } = require('../services/legacy/adapterRegistry');
const legacyMigrationService  = require('../services/legacyMigrationService');
const { supabase }            = require('../services/supabase');
const logger                  = require('../logger');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// ── GET /api/v1/integrations/systems ─────────────────────────────────────────
router.get(
  '/integrations/systems',
  requireAuth,
  requireRole(['admin']),
  async (_req, res) => {
    try {
      const out = [];
      for (const sys of SYSTEMS) {
        const adapter = getAdapter(sys.system);
        let health;
        try { health = await adapter.healthCheck(); }
        catch (err) { health = { ok: false, system: sys.system, detail: err.message }; }

        const { data: claims } = await supabase
          .from('claims')
          .select('id')
          .eq('source_system', sys.system);

        out.push({
          ...sys,
          health,
          claim_count: (claims || []).length,
        });
      }
      res.json({ systems: out });
    } catch (err) {
      logger.error({ msg: 'GET /integrations/systems failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  },
);

// ── POST /api/v1/integrations/:system/migrate ────────────────────────────────
router.post(
  '/integrations/:system/migrate',
  requireAuth,
  requireRole(['admin']),
  [param('system').isString().isLength({ min: 2, max: 40 })],
  validate,
  async (req, res) => {
    try {
      const result = await legacyMigrationService.migrateFromLegacy(req.params.system, req.body || {});
      res.json(result);
    } catch (err) {
      logger.error({ msg: 'POST /integrations/:system/migrate failed',
        system: req.params.system, err: err.message });
      res.status(400).json({ error: err.message });
    }
  },
);

// ── GET /api/v1/integrations/migrated ────────────────────────────────────────
router.get(
  '/integrations/migrated',
  requireAuth,
  requireRole(['admin']),
  async (_req, res) => {
    try {
      const claims = await legacyMigrationService.listMigrated();
      res.json({ count: claims.length, claims });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── GET /api/v1/integrations/:system/legacy-record/:externalId ──────────────
// Returns whatever the adapter's backing store has for a single external
// claim id: the original legacy_claims row plus every diary, document, and
// field update that this platform has pushed back to it. The Integrations
// view uses this to show the round trip end-to-end.
router.get(
  '/integrations/:system/legacy-record/:externalId',
  requireAuth,
  requireRole(['admin']),
  [
    param('system').isString().isLength({ min: 2, max: 40 }),
    param('externalId').isString().isLength({ min: 1, max: 120 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { system, externalId } = req.params;
      if (system !== 'mock_legacy') {
        return res.status(400).json({
          error: `legacy-record introspection only available for mock_legacy (got '${system}')`,
        });
      }

      const [{ data: claimRow }, { data: diaries }, { data: documents }, { data: updates }] =
        await Promise.all([
          supabase.from('legacy_claims').select('*').eq('external_id', externalId).single(),
          supabase.from('legacy_diaries').select('*').eq('external_claim_id', externalId),
          supabase.from('legacy_documents').select('*').eq('external_claim_id', externalId),
          supabase.from('legacy_updates').select('*').eq('external_claim_id', externalId),
        ]);

      res.json({
        external_id: externalId,
        system,
        legacy_claim: claimRow || null,
        diaries:      diaries   || [],
        documents:    documents || [],
        updates:      updates   || [],
      });
    } catch (err) {
      logger.error({ msg: 'GET /integrations/.../legacy-record failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = router;
