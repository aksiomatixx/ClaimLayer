'use strict';

/**
 * wcis.js — M22A admin routes for the WCIS EDI pipeline.
 *
 * All routes require admin role. Mounted at /api/v1/wcis in
 * backend/src/index.js.
 *
 * Routes:
 *   POST /api/v1/wcis/transactions/:id/generate-correction
 *   GET  /api/v1/wcis/claims/:id/state
 *   GET  /api/v1/wcis/queue/pending
 *   GET  /api/v1/wcis/transmissions/recent
 *   POST /api/v1/wcis/admin/health
 *   POST /api/v1/wcis/admin/transactions/:id/abandon
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const wcisPayloadService      = require('../services/wcisPayloadService');
const wcisTransmissionService = require('../services/wcisTransmissionService');
const logger = require('../logger');

const router = express.Router();

// All routes require admin role.
router.use(requireAuth, requireRole(['admin']));

function _mapError(err, res) {
  const msg = err && err.message ? err.message : 'Internal server error';
  if (err && err.name === 'WcisValidationError') {
    return res.status(422).json({ error: 'validation_failed', details: err.errors });
  }
  if (err && err.name === 'AdapterNotImplemented') {
    return res.status(501).json({ error: msg, milestone: err.milestone });
  }
  if (/not found/i.test(msg)) {
    return res.status(404).json({ error: msg });
  }
  return res.status(400).json({ error: msg });
}

// ─── POST /transactions/:id/generate-correction ──────────────────
router.post('/transactions/:id/generate-correction', async (req, res) => {
  try {
    const { corrected_payload, reason } = req.body || {};
    const newTxn = await wcisPayloadService.regeneratePayload(req.params.id, {
      corrected_payload, reason,
    });
    res.json(newTxn);
  } catch (err) {
    _mapError(err, res);
  }
});

// ─── GET /claims/:id/state ───────────────────────────────────────
router.get('/claims/:id/state', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('wcis_claim_state')
      .select('*')
      .eq('claim_id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'not found' });
    res.json(data);
  } catch (err) {
    _mapError(err, res);
  }
});

// ─── GET /queue/pending ──────────────────────────────────────────
router.get('/queue/pending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const env   = req.query.environment;
    let q = supabase.from('wcis_trigger_queue')
      .select('*')
      .eq('status', 'pending')
      .order('deadline_date', { ascending: true })
      .limit(limit);
    if (env) q = q.eq('environment', env);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    _mapError(err, res);
  }
});

// ─── GET /transmissions/recent ───────────────────────────────────
router.get('/transmissions/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '25', 10) || 25, 100);
    const env   = req.query.environment;
    let q = supabase.from('wcis_transmissions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (env) q = q.eq('environment', env);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    _mapError(err, res);
  }
});

// ─── POST /admin/health ──────────────────────────────────────────
router.post('/admin/health', async (_req, res) => {
  try {
    const adapter = await wcisTransmissionService.getActiveAdapter();
    const result = await adapter.healthCheck();
    res.json({ adapter: adapter.name, ...result });
  } catch (err) {
    _mapError(err, res);
  }
});

// ─── POST /admin/transactions/:id/abandon ────────────────────────
router.post('/admin/transactions/:id/abandon', async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'no reason provided';
    const { data: existing } = await supabase
      .from('wcis_transactions')
      .select('id,status')
      .eq('id', req.params.id)
      .single();
    if (!existing) return res.status(404).json({ error: 'not found' });

    const { error } = await supabase
      .from('wcis_transactions')
      .update({
        status: 'abandoned',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (error) throw new Error(error.message);

    logger.warn({
      msg: 'wcis admin: transaction abandoned',
      transaction_id: req.params.id, reason, by: req.user && req.user.id,
    });
    res.json({ ok: true, transaction_id: req.params.id, reason });
  } catch (err) {
    _mapError(err, res);
  }
});

// ── GET /api/v1/wcis/quality-metrics — DWC Audit-Unit-style dashboard ───────
// Rejection/TE rates, late + ack-overdue counts, claims with no accepted
// FROI, and per-MTC-family rejection breakdown. Metrics become meaningful
// once a real adapter produces production acks; on the stub they reflect
// synthesized acks.
router.get('/quality-metrics', requireAuth, requireRole(['admin']), async (_req, res) => {
  try {
    const { data: txData }   = await supabase.from('wcis_transactions').select('*');
    const { data: qData } = await supabase.from('wcis_trigger_queue').select('*');
    const { data: sData } = await supabase.from('wcis_claim_state').select('*');
    const txs = txData || [], queue = qData || [], states = sData || [];

    const transmitted = txs.filter(t =>
      ['transmitted', 'stub_transmitted', 'accepted', 'accepted_with_error', 'rejected'].includes(t.status));
    const rejected = txs.filter(t => t.status === 'rejected');
    const te       = txs.filter(t => t.status === 'accepted_with_error');
    const today = new Date().toISOString().split('T')[0];
    const ackOverdue = txs.filter(t =>
      ['transmitted', 'stub_transmitted'].includes(t.status) && !t.ack_received_at);
    const lateQueue = queue.filter(q =>
      q.status === 'pending' && q.deadline_date && q.deadline_date < today);

    const byFamily = {};
    for (const t of transmitted) {
      const fam = t.mtc_family || 'UNKNOWN';
      byFamily[fam] = byFamily[fam] || { transmitted: 0, rejected: 0, te: 0 };
      byFamily[fam].transmitted += 1;
      if (t.status === 'rejected') byFamily[fam].rejected += 1;
      if (t.status === 'accepted_with_error') byFamily[fam].te += 1;
    }

    const pct = (n, d) => d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
    res.json({
      transmitted_total: transmitted.length,
      rejection_rate_pct: pct(rejected.length, transmitted.length),
      te_rate_pct: pct(te.length, transmitted.length),
      ack_overdue_count: ackOverdue.length,
      late_pending_triggers: lateQueue.length,
      claims_without_accepted_froi: states.filter(s => !s.first_froi_accepted_at).length,
      by_mtc_family: byFamily,
      adapter_note: 'Metrics reflect the configured WCIS adapter; stub-synthesized acks are not production data.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
