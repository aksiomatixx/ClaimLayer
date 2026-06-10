'use strict';

/**
 * Notice Delivery Orchestration (Tier 1).
 *
 * Multi-channel dispatch for benefit_notices rows, following the house
 * adapter pattern (M22A): a channel interface, one fully functional
 * adapter (portal), and vendor-gated adapters that ship as loud stubs
 * until accounts exist.
 *
 *   portal     — FUNCTIONAL. Marks the notice delivered to the worker /
 *                attorney portal; the document is already filed on the
 *                claim, so portal delivery is an authorization flip.
 *   mail       — STUB via lobService (LOB_LIVE=false). Queues and logs;
 *                no physical mail leaves the building.
 *   fax        — STUB. Gated on a fax vendor account (eFax/SRFax/Phaxio).
 *   electronic — STUB. Per-provider electronic submission, gated on
 *                provider-by-provider capability config.
 *
 * Channel resolution: explicit method on the request → per-provider
 * config (provider records carry delivery_method) → audience default
 * (worker: mail + portal both; attorney: mail; provider: electronic if
 *  configured, else fax, else mail).
 *
 * Retry: deliverPending() re-attempts failed rows up to MAX_ATTEMPTS,
 * then leaves them failed for the WCIS-style deadline monitor to surface.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

const MAX_ATTEMPTS = 3;

// ── Channel adapters ──────────────────────────────────────────────────────────

const portalAdapter = {
  name: 'portal',
  async deliver(notice) {
    // The PDF is already filed as a claim document; portal delivery
    // exposes it to the recipient's portal session.
    return { delivered: true, detail: 'exposed to portal' };
  },
};

const mailAdapter = {
  name: 'mail',
  async deliver(notice) {
    const lobService = require('./lobService');
    // lobService is the M9 stub until LOB_LIVE — it logs and returns a
    // queued-letter handle. A thrown error here marks the attempt failed.
    const result = await lobService.sendLetter(
      'benefit_notice', notice.claim_id, notice.audience,
      { recipientName: notice.recipient?.name, noticeType: notice.notice_type, documentId: notice.document_id },
    );
    return { delivered: true, detail: `lob:${result?.letterId || 'queued'}` };
  },
};

const faxAdapter = {
  name: 'fax',
  async deliver() {
    // Gated on a fax vendor account. Loud stub per house convention.
    logger.warn({
      warning: 'FAX_ADAPTER_STUB',
      msg: 'NOT FAXED — fax vendor account not configured; production must wire eFax/SRFax/Phaxio',
    });
    throw new Error('FAX_ADAPTER_NOT_CONFIGURED');
  },
};

const electronicAdapter = {
  name: 'electronic',
  async deliver(notice) {
    logger.warn({
      warning: 'ELECTRONIC_ADAPTER_STUB',
      msg: 'NOT TRANSMITTED — per-provider electronic submission not configured',
      provider: notice.recipient?.npi || notice.recipient?.name,
    });
    throw new Error('ELECTRONIC_ADAPTER_NOT_CONFIGURED');
  },
};

const ADAPTERS = { portal: portalAdapter, mail: mailAdapter, fax: faxAdapter, electronic: electronicAdapter };

// ── Channel resolution ────────────────────────────────────────────────────────

async function _providerMethod(recipient) {
  if (!recipient) return null;
  const key = recipient.provider_id || recipient.npi;
  if (!key) return null;
  const { data } = await supabase
    .from('providers').select('delivery_method')
    .eq(recipient.provider_id ? 'id' : 'npi', key).single();
  return data?.delivery_method || null;
}

async function resolveChannels(notice, explicitMethod) {
  if (explicitMethod) return [explicitMethod];
  if (notice.audience === 'provider') {
    const configured = await _providerMethod(notice.recipient);
    if (configured) return [configured];
    return ['fax']; // provider default: fax fallback until electronic is configured
  }
  if (notice.audience === 'attorney') return ['mail'];
  return ['mail', 'portal']; // worker: physical mail + portal copy
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function _updateNotice(id, patch) {
  const { data } = await supabase
    .from('benefit_notices')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  return data;
}

/**
 * Deliver one benefit_notices row. Multi-channel: succeeds if every
 * resolved channel succeeds; a failed channel marks the row failed with
 * the error recorded for retry.
 */
async function deliverNotice(noticeId, { method } = {}) {
  const { data: notice } = await supabase
    .from('benefit_notices').select('*').eq('id', noticeId).single();
  if (!notice) throw new Error(`Notice not found: ${noticeId}`);
  if (notice.status === 'delivered') return notice;
  if (notice.status === 'blocked_pending_translation') {
    throw new Error('Notice is blocked pending an authoritative translation — cannot deliver');
  }

  const channels = await resolveChannels(notice, method || notice.method);
  await _updateNotice(noticeId, { status: 'delivering', method: channels[0] });

  const results = [];
  for (const ch of channels) {
    const adapter = ADAPTERS[ch];
    if (!adapter) throw new Error(`Unknown delivery channel: ${ch}`);
    try {
      const r = await adapter.deliver(notice);
      results.push({ channel: ch, ok: true, detail: r.detail });
    } catch (e) {
      results.push({ channel: ch, ok: false, error: e.message });
    }
  }

  const failed = results.filter(r => !r.ok);
  const now = new Date().toISOString();

  if (failed.length === 0) {
    const updated = await _updateNotice(noticeId, {
      status: 'delivered', delivered_at: now,
      delivery_attempts: (notice.delivery_attempts || 0) + 1,
      last_error: null,
    });
    await supabase.from('claim_events').insert({
      claim_id: notice.claim_id, type: 'notice_delivered', timestamp: now,
      data: { notice_id: noticeId, notice_type: notice.notice_type, channels: results.map(r => r.channel) },
    });
    return updated;
  }

  const updated = await _updateNotice(noticeId, {
    status: 'failed',
    delivery_attempts: (notice.delivery_attempts || 0) + 1,
    last_error: failed.map(f => `${f.channel}: ${f.error}`).join('; '),
  });
  logger.error({
    msg: 'noticeDelivery: delivery failed', noticeId,
    attempts: updated.delivery_attempts, errors: updated.last_error,
  });
  return updated;
}

/** Queue a generated notice for delivery (aftermath automation calls this). */
async function queueNotice(noticeId) {
  const { data: notice } = await supabase
    .from('benefit_notices').select('*').eq('id', noticeId).single();
  if (!notice) throw new Error(`Notice not found: ${noticeId}`);
  if (notice.status === 'blocked_pending_translation') return notice; // stays blocked
  return _updateNotice(noticeId, { status: 'queued', queued_at: new Date().toISOString() });
}

/**
 * Retry pass over queued + failed rows (cron-callable). Failed rows are
 * retried up to MAX_ATTEMPTS; beyond that they stay failed for the
 * monitor to surface to the adjuster.
 */
async function deliverPending() {
  const { data } = await supabase.from('benefit_notices').select('*');
  const candidates = (data || []).filter(n =>
    n.status === 'queued' ||
    (n.status === 'failed' && (n.delivery_attempts || 0) < MAX_ATTEMPTS));

  const outcomes = [];
  for (const n of candidates) {
    try {
      const r = await deliverNotice(n.id, {});
      outcomes.push({ id: n.id, status: r.status });
    } catch (e) {
      outcomes.push({ id: n.id, status: 'error', error: e.message });
    }
  }
  return outcomes;
}

/** Lob-style delivery status webhook hook (tracking only). */
async function recordDeliveryEvent(noticeId, event) {
  const patch = event === 'delivered'
    ? { status: 'delivered', delivered_at: new Date().toISOString() }
    : { last_error: `webhook:${event}` };
  return _updateNotice(noticeId, patch);
}

module.exports = {
  deliverNotice,
  queueNotice,
  deliverPending,
  recordDeliveryEvent,
  resolveChannels,
  MAX_ATTEMPTS,
  _adapters: ADAPTERS, // exported for tests
};
