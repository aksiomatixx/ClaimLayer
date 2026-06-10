'use strict';

/**
 * admin.js — admin-only ops endpoints.
 *
 * Currently exposes the demo-reset endpoint. Always blocked when
 * NODE_ENV === 'production' so a careless prod deploy can never wipe
 * customer claim data.
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const logger = require('../logger');

const router = express.Router();

// ── POST /api/v1/admin/demo-reset ────────────────────────────────────────────
// Wipes every claim with metadata.demo === true and re-runs the seed.
// Returns { count, ids }.
router.post(
  '/demo-reset',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Demo reset not available in production' });
    }
    try {
      // Lazy-require so production deploys don't load the seed module
      const { seedDemo } = require('../scripts/seedDemo');
      const result = await seedDemo();
      logger.info({ msg: 'admin/demo-reset: re-seeded', count: result.count, by: req.user?.email });
      res.json({ ok: true, count: result.count, ids: result.ids });
    } catch (err) {
      logger.error({ msg: 'admin/demo-reset failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/admin/workers/notice-delivery/run ───────────────────────────
// Authenticated internal trigger for the notice-delivery worker — the
// same entry point the production scheduler calls. Concurrency-safe:
// rows are claimed with conditional updates inside the service.
router.post(
  '/workers/notice-delivery/run',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const worker = require('../cron/noticeDeliveryWorker');
      const result = await worker.run(`admin-trigger_${req.user?.email || 'unknown'}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ msg: 'admin/workers/notice-delivery: run failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/admin/demo-status ────────────────────────────────────────────
// Lightweight check used by the frontend banner. Returns the count of
// demo-flagged claims; the banner shows when count > 0.
router.get(
  '/demo-status',
  requireAuth,
  requireRole(['admin']),
  async (_req, res) => {
    try {
      const { data } = await supabase.from('claims').select('id, metadata');
      const demoCount = (data || []).filter(c => c.metadata && c.metadata.demo === true).length;
      res.json({ demo: demoCount > 0, count: demoCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
