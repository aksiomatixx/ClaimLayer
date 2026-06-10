'use strict';

/**
 * Notice Delivery Orchestration (Tier 1 — hardened).
 *
 * Multi-channel dispatch for benefit_notices rows, following the house
 * adapter pattern (M22A): a channel interface, one fully functional
 * adapter (portal), and vendor-gated adapters that ship as loud stubs
 * until accounts exist.
 *
 * TRUTHFUL STATE MODEL (Finding 3 of the production-hardening pass):
 * a queued or stubbed request is never "delivered".
 *
 *   Channel states (benefit_notice_channels, one row per channel):
 *     pending    — planned, not yet attempted
 *     submitted  — handed to the provider (e.g. Lob accepted the
 *                  letter); physical delivery NOT yet confirmed
 *     delivered  — verified: portal exposure checked against the filed
 *                  document, or a verified provider delivery webhook
 *     failed     — attempt errored (retryable until MAX_ATTEMPTS)
 *
 *   Notice states (benefit_notices.status):
 *     generated → queued → delivering (locked) →
 *       delivered  — every channel verified delivered
 *       submitted  — all channels submitted/delivered, awaiting
 *                    provider confirmation; retries DO NOT resend these
 *       failed     — at least one channel failed; retried up to
 *                    MAX_ATTEMPTS, then surfaced as a CRITICAL diary
 *     blocked_pending_translation — never deliverable until an
 *       authoritative translation exists
 *
 *   Only recordLobEvent (signature-verified webhook) may move a mail
 *   channel to delivered. Channels are tracked independently, so a
 *   retry never resends a channel that already submitted or delivered.
 *
 * CONCURRENCY (Finding 4): deliverNotice claims the row with a
 * conditional update (status CAS + locked_by/locked_at); two workers
 * running deliverPending() cannot deliver the same notice. Stale locks
 * (a crashed worker) are reclaimed after LOCK_TTL_MS.
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');

const MAX_ATTEMPTS = 3;
const LOCK_TTL_MS  = 10 * 60 * 1000;

function _id(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ── Channel adapters ──────────────────────────────────────────────────────────
// Each returns { state: 'delivered'|'submitted', ref?, detail } or throws.

const portalAdapter = {
  name: 'portal',
  async deliver(notice) {
    // Portal delivery is only true if the recipient can actually open
    // the document: it must exist, be filed on THIS claim, and carry
    // renderable content.
    if (!notice.document_id) {
      throw new Error('PORTAL_DOCUMENT_MISSING — notice has no filed document');
    }
    const { data: doc, error } = await supabase
      .from('claim_documents').select('*').eq('id', notice.document_id).single();
    if (error || !doc) throw new Error('PORTAL_DOCUMENT_MISSING — filed document not found');
    if (doc.claim_id !== notice.claim_id) {
      throw new Error('PORTAL_DOCUMENT_MISMATCH — document is not filed on this claim');
    }
    if (doc.status !== 'filed') {
      throw new Error(`PORTAL_DOCUMENT_UNAVAILABLE — document status is '${doc.status}'`);
    }
    if (!doc.pdf_buffer_b64 && !doc.content_text) {
      throw new Error('PORTAL_DOCUMENT_EMPTY — document has no renderable content');
    }
    return { state: 'delivered', detail: `exposed to portal (document ${doc.id} verified)` };
  },
};

const mailAdapter = {
  name: 'mail',
  async deliver(notice) {
    const lobService = require('./lobService');
    // Submission to the print/mail provider — whether the live API or
    // the LOB_LIVE=false stub — is SUBMITTED, never delivered. Only a
    // verified Lob delivery webhook (recordLobEvent) flips this channel
    // to delivered.
    const result = await lobService.sendLetter(
      'benefit_notice', notice.claim_id, notice.audience,
      { recipientName: notice.recipient?.name, noticeType: notice.notice_type, documentId: notice.document_id },
    );
    if (!result?.letterId) throw new Error('MAIL_SUBMISSION_FAILED — no letter id returned');
    return { state: 'submitted', ref: result.letterId, detail: `lob:${result.letterId} (${result.status})` };
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

// ── Row helpers ───────────────────────────────────────────────────────────────

async function _updateNotice(id, patch) {
  const { data, error } = await supabase
    .from('benefit_notices')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw new Error(`noticeDelivery: notice update failed — ${error.message}`);
  return data;
}

async function _updateChannel(id, patch) {
  const { data, error } = await supabase
    .from('benefit_notice_channels')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw new Error(`noticeDelivery: channel update failed — ${error.message}`);
  return data;
}

/**
 * The per-channel tracking rows for a notice; created from the channel
 * plan on first touch so retries operate on a stable, independent set.
 */
async function ensureChannels(notice, explicitMethod) {
  const { data: existing, error } = await supabase
    .from('benefit_notice_channels').select('*').eq('notice_id', notice.id);
  if (error) throw new Error(`noticeDelivery: channel lookup failed — ${error.message}`);
  if (existing && existing.length > 0) return existing;

  const channels = await resolveChannels(notice, explicitMethod || notice.method);
  const now = new Date().toISOString();
  const rows = channels.map(ch => ({
    id: _id('bnc'),
    notice_id: notice.id,
    claim_id: notice.claim_id,
    channel: ch,
    status: 'pending',
    provider_ref: null,
    attempts: 0,
    last_error: null,
    submitted_at: null,
    delivered_at: null,
    created_at: now,
    updated_at: now,
  }));
  const { error: insErr } = await supabase.from('benefit_notice_channels').insert(rows);
  if (insErr) throw new Error(`noticeDelivery: channel insert failed — ${insErr.message}`);
  return rows;
}

// ── Terminal-failure surfacing ────────────────────────────────────────────────

async function _surfaceTerminalFailure(notice, reason) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('diaries').insert({
    id: _id('diy'),
    claim_id: notice.claim_id,
    diary_type: 'NOTICE_DELIVERY_FAILED',
    due_date: now.split('T')[0],
    assigned_to: config.adjuster.email,
    priority: 'CRITICAL',
    status: 'open',
    no_snooze: true,
    notes: `Delivery of "${notice.notice_type}" (${notice.id}, ${notice.audience}) failed terminally: ${reason}`,
    created_at: now,
  });
  if (error) {
    logger.error({ msg: 'noticeDelivery: failed to surface terminal failure as diary', noticeId: notice.id, err: error.message });
  }
}

// ── Status recomputation (shared by delivery + webhook paths) ────────────────

function _aggregateStatus(channels) {
  const states = channels.map(c => c.status);
  if (states.every(s => s === 'delivered')) return 'delivered';
  if (states.some(s => s === 'failed')) return 'failed';
  if (states.every(s => s === 'delivered' || s === 'submitted')) return 'submitted';
  return 'queued'; // still has pending channels and no failures
}

async function _applyAggregate(notice, channels, { attempted } = {}) {
  const now = new Date().toISOString();
  const agg = _aggregateStatus(channels);
  const patch = {
    status: agg,
    locked_by: null,
    locked_at: null,
  };
  if (attempted) patch.delivery_attempts = (notice.delivery_attempts || 0) + 1;

  if (agg === 'delivered') {
    patch.delivered_at = now;
    patch.last_error = null;
  } else if (agg === 'failed') {
    patch.last_error = channels
      .filter(c => c.status === 'failed')
      .map(c => `${c.channel}: ${c.last_error}`).join('; ');
  } else if (agg === 'submitted') {
    patch.submitted_at = notice.submitted_at || now;
    patch.last_error = null;
  }

  const updated = await _updateNotice(notice.id, patch);

  if (agg === 'delivered' && notice.status !== 'delivered') {
    const { error } = await supabase.from('claim_events').insert({
      claim_id: notice.claim_id, type: 'notice_delivered', timestamp: now,
      data: {
        notice_id: notice.id, notice_type: notice.notice_type,
        channels: channels.map(c => ({ channel: c.channel, delivered_at: c.delivered_at })),
      },
    });
    if (error) logger.error({ msg: 'noticeDelivery: notice_delivered event insert failed', err: error.message });
  }

  if (agg === 'failed' && (updated.delivery_attempts || 0) >= MAX_ATTEMPTS) {
    await _surfaceTerminalFailure(updated, updated.last_error || 'max attempts exhausted');
  }

  return updated;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Deliver one benefit_notices row. Claims the row first (conditional
 * update), attempts only channels that are pending or failed — never a
 * channel that already submitted or delivered — then recomputes the
 * truthful aggregate status and releases the lock.
 *
 * Returns the updated row, or the unmodified row when there is nothing
 * to do / another worker holds the claim.
 */
async function deliverNotice(noticeId, { method, workerId } = {}) {
  const { data: notice, error } = await supabase
    .from('benefit_notices').select('*').eq('id', noticeId).single();
  if (error || !notice) throw new Error(`Notice not found: ${noticeId}`);

  if (notice.status === 'delivered') return notice; // idempotent
  if (notice.status === 'blocked_pending_translation') {
    throw new Error('Notice is blocked pending an authoritative translation — cannot deliver');
  }
  if (notice.status === 'submitted') {
    // Awaiting provider confirmation — nothing to resend.
    return notice;
  }

  // Claim the row: status CAS prevents two workers delivering the same
  // notice concurrently.
  const lockOwner = workerId || _id('wkr');
  const { data: claimed, error: claimErr } = await supabase
    .from('benefit_notices')
    .update({ status: 'delivering', locked_by: lockOwner, locked_at: new Date().toISOString() })
    .eq('id', noticeId).eq('status', notice.status)
    .select();
  if (claimErr) throw new Error(`noticeDelivery: claim failed — ${claimErr.message}`);
  if (!claimed || claimed.length === 0) {
    logger.info({ msg: 'noticeDelivery: row already claimed — skipping', noticeId });
    return notice;
  }

  const channels = await ensureChannels(notice, method);

  let attempted = false;
  for (const ch of channels) {
    if (ch.status === 'submitted' || ch.status === 'delivered') continue; // never resend
    const adapter = ADAPTERS[ch.channel];
    if (!adapter) {
      Object.assign(ch, await _updateChannel(ch.id, {
        status: 'failed', attempts: (ch.attempts || 0) + 1,
        last_error: `Unknown delivery channel: ${ch.channel}`,
      }));
      attempted = true;
      continue;
    }
    attempted = true;
    try {
      const r = await adapter.deliver(notice);
      const now = new Date().toISOString();
      const patch = {
        status: r.state,
        attempts: (ch.attempts || 0) + 1,
        last_error: null,
        provider_ref: r.ref || ch.provider_ref,
      };
      if (r.state === 'submitted') patch.submitted_at = now;
      if (r.state === 'delivered') patch.delivered_at = now;
      Object.assign(ch, await _updateChannel(ch.id, patch));
    } catch (e) {
      Object.assign(ch, await _updateChannel(ch.id, {
        status: 'failed', attempts: (ch.attempts || 0) + 1, last_error: e.message,
      }));
    }
  }

  const updated = await _applyAggregate({ ...notice }, channels, { attempted });
  if (updated.status === 'failed') {
    logger.error({
      msg: 'noticeDelivery: delivery failed', noticeId,
      attempts: updated.delivery_attempts, errors: updated.last_error,
    });
  }
  return updated;
}

/** Queue a generated notice for delivery (aftermath automation calls this). */
async function queueNotice(noticeId) {
  const { data: notice, error } = await supabase
    .from('benefit_notices').select('*').eq('id', noticeId).single();
  if (error || !notice) throw new Error(`Notice not found: ${noticeId}`);
  if (notice.status === 'blocked_pending_translation') return notice; // stays blocked
  const updated = await _updateNotice(noticeId, { status: 'queued', queued_at: new Date().toISOString() });
  await ensureChannels(updated);
  return updated;
}

/**
 * Retry pass over deliverable rows (the notice-delivery worker entry
 * point). Failed rows are retried up to MAX_ATTEMPTS; submitted rows
 * wait for the provider webhook; stale 'delivering' locks (crashed
 * worker) are reclaimed after LOCK_TTL_MS. Concurrent workers are safe:
 * each row is claimed with a conditional update.
 */
async function deliverPending(workerId) {
  const owner = workerId || _id('wkr');
  const { data, error } = await supabase.from('benefit_notices').select('*');
  if (error) throw new Error(`noticeDelivery: pending scan failed — ${error.message}`);

  const now = Date.now();
  const outcomes = [];

  for (const n of data || []) {
    // Reclaim stale locks first: CAS on the exact stale lock timestamp.
    if (n.status === 'delivering' && n.locked_at && (now - Date.parse(n.locked_at)) > LOCK_TTL_MS) {
      const { data: reclaimed } = await supabase
        .from('benefit_notices')
        .update({ status: 'failed', locked_by: null, locked_at: null, last_error: `stale lock reclaimed (was ${n.locked_by})` })
        .eq('id', n.id).eq('status', 'delivering').eq('locked_at', n.locked_at)
        .select();
      if (reclaimed && reclaimed.length > 0) n.status = 'failed';
      else continue;
    }

    const retryable =
      n.status === 'queued' ||
      (n.status === 'failed' && (n.delivery_attempts || 0) < MAX_ATTEMPTS);
    if (!retryable) continue;

    try {
      const r = await deliverNotice(n.id, { workerId: owner });
      outcomes.push({ id: n.id, status: r.status });
    } catch (e) {
      outcomes.push({ id: n.id, status: 'error', error: e.message });
    }
  }
  return outcomes;
}

// ── Lob webhook processing (the only path to mail 'delivered') ───────────────

const LOB_DELIVERED_EVENTS = ['letter.delivered'];
const LOB_FAILED_EVENTS    = ['letter.returned_to_sender', 'letter.failed', 'letter.deleted'];

/**
 * Process a signature-verified Lob webhook event. Idempotent on the
 * Lob event id: duplicate deliveries of the same event are acknowledged
 * without reprocessing.
 */
async function recordLobEvent(event) {
  const eventId  = event?.id;
  const type     = typeof event?.event_type === 'object' ? event.event_type?.id : event?.event_type;
  const letterId = event?.body?.id || event?.reference_id || null;

  if (!eventId || !type) return { ignored: true, reason: 'malformed_event' };

  // Idempotency: one row per provider event id.
  const { data: seen, error: seenErr } = await supabase
    .from('webhook_events').select('id').eq('provider_event_id', eventId);
  if (seenErr) throw new Error(`noticeDelivery: webhook dedupe lookup failed — ${seenErr.message}`);
  if (seen && seen.length > 0) return { duplicate: true };

  const { error: insErr } = await supabase.from('webhook_events').insert({
    id: _id('whk'),
    provider: 'lob',
    provider_event_id: eventId,
    event_type: type,
    payload: event,
    received_at: new Date().toISOString(),
  });
  if (insErr) throw new Error(`noticeDelivery: webhook event insert failed — ${insErr.message}`);

  if (!letterId) return { ignored: true, reason: 'no_letter_reference' };

  const { data: chRows, error: chErr } = await supabase
    .from('benefit_notice_channels').select('*').eq('provider_ref', letterId);
  if (chErr) throw new Error(`noticeDelivery: channel lookup failed — ${chErr.message}`);
  const channel = (chRows || [])[0];
  if (!channel) {
    logger.warn({ msg: 'noticeDelivery: Lob event for unknown letter', letterId, type });
    return { ignored: true, reason: 'unknown_letter' };
  }

  const now = new Date().toISOString();
  if (LOB_DELIVERED_EVENTS.includes(type)) {
    await _updateChannel(channel.id, { status: 'delivered', delivered_at: now, last_error: null });
  } else if (LOB_FAILED_EVENTS.includes(type)) {
    await _updateChannel(channel.id, { status: 'failed', last_error: `provider event: ${type}` });
  } else {
    // Progress events (letter.processed, letter.in_transit, …) are
    // recorded but change no delivery truth.
    await _updateChannel(channel.id, { last_error: null, last_event: type });
    return { recorded: true, progress: type };
  }

  // Recompute the notice aggregate from ALL its channels.
  const { data: notice, error: nErr } = await supabase
    .from('benefit_notices').select('*').eq('id', channel.notice_id).single();
  if (nErr || !notice) throw new Error(`noticeDelivery: notice ${channel.notice_id} not found for letter ${letterId}`);
  const { data: allChannels } = await supabase
    .from('benefit_notice_channels').select('*').eq('notice_id', notice.id);
  const updated = await _applyAggregate(notice, allChannels || [], { attempted: false });

  if (LOB_FAILED_EVENTS.includes(type)) {
    await _surfaceTerminalFailure(updated, `physical mail ${type} (letter ${letterId})`);
  }

  return { recorded: true, notice_id: notice.id, notice_status: updated.status };
}

/** Channel rows for a notice (read API for routes/tests). */
async function listChannels(noticeId) {
  const { data, error } = await supabase
    .from('benefit_notice_channels').select('*').eq('notice_id', noticeId);
  if (error) throw new Error(`noticeDelivery: channel list failed — ${error.message}`);
  return data || [];
}

module.exports = {
  deliverNotice,
  queueNotice,
  deliverPending,
  recordLobEvent,
  resolveChannels,
  ensureChannels,
  listChannels,
  MAX_ATTEMPTS,
  LOCK_TTL_MS,
  _adapters: ADAPTERS, // exported for tests
};
