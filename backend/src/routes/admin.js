'use strict';

/**
 * admin.js — admin-only ops endpoints.
 *
 * Demo reset (always blocked when NODE_ENV === 'production' so a careless
 * prod deploy can never wipe customer claim data), worker triggers, and
 * job-queue operations.
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

// ── POST /api/v1/admin/workers/outbox/run ────────────────────────────────────
// Authenticated internal trigger for the integration-outbox dispatcher
// (FileHandler write-back retries).
router.post(
  '/workers/outbox/run',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const worker = require('../cron/outboxWorker');
      const result = await worker.run(`admin-trigger_${req.user?.email || 'unknown'}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ msg: 'admin/workers/outbox: run failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Durable job queue (ADR-0006) ─────────────────────────────────────────────
// Available only in transactional mode (DATABASE_URL); in the DB-less
// compatibility mode jobs run inline and there is no queue to inspect.
function _requireJobQueue(res) {
  if (require('../db/unitOfWork').isTransactional()) return true;
  res.status(503).json({ error: 'The durable job queue requires DATABASE_URL (transactional mode)' });
  return false;
}

// POST /api/v1/admin/workers/jobs/run — drain due jobs now (scheduler hook).
router.post(
  '/workers/jobs/run',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    if (!_requireJobQueue(res)) return;
    try {
      const result = await require('../cron/jobWorker').run();
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ msg: 'admin/workers/jobs: run failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/v1/admin/jobs?status=dead&queue=&claim_id=&limit= — the tenant's jobs.
router.get(
  '/jobs',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    if (!_requireJobQueue(res)) return;
    try {
      const { humanPrincipal } = require('../policy/principal');
      const jobs = await require('../services/jobQueue').list({
        tenantId: humanPrincipal(req.user).tenantId,
        status:   req.query.status || null,
        queue:    req.query.queue || null,
        claimId:  req.query.claim_id || null,
        limit:    parseInt(req.query.limit || '100', 10),
      });
      res.json({ jobs });
    } catch (err) {
      logger.error({ msg: 'admin/jobs: list failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/v1/admin/jobs/:id/requeue — re-run a dead-lettered job (ledgered).
router.post(
  '/jobs/:id/requeue',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    if (!_requireJobQueue(res)) return;
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid job id' });
    try {
      const { humanPrincipal } = require('../policy/principal');
      const job = await require('../services/jobQueue').requeueDead(req.params.id, humanPrincipal(req.user));
      if (!job) return res.status(409).json({ error: 'job not found or not dead' });
      res.json({ ok: true, job: { id: job.id, queue: job.queue, status: job.status } });
    } catch (err) {
      logger.error({ msg: 'admin/jobs: requeue failed', err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/admin/workers/supervisor-alerts/run ────────────────────────
// Authenticated internal trigger for the daily supervisor digest.
router.post(
  '/workers/supervisor-alerts/run',
  requireAuth,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const worker = require('../cron/supervisorAlertWorker');
      const result = await worker.run(req.body?.date);
      res.json({ ok: true, ...result, alerts: (result.alerts || []).length });
    } catch (err) {
      logger.error({ msg: 'admin/workers/supervisor-alerts: run failed', err: err.message });
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
