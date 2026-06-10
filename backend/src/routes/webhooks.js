'use strict';

/**
 * Webhook receivers for:
 *   • Manifest MedEx / DxF  →  /webhooks/dxf/adt
 *   • Enlyte UR              →  /webhooks/enlyte/determination
 *   • Lob.com delivery       →  /webhooks/lob/delivery
 *
 * Signature policy (Finding 8 of the production-hardening pass):
 *   - This router mounts BEFORE the global express.json() so every
 *     route receives the exact raw request bytes (express.raw) and HMAC
 *     verification can never run against a re-serialized body.
 *   - Production fails CLOSED: a missing secret or missing signature is
 *     a 401, always.
 *   - Outside production the bypass is explicit and narrow: only when
 *     no secret is configured for that webhook. If a secret IS
 *     configured (as in the signature tests), verification runs the
 *     same code path as production.
 *
 * Lob signs per its documented scheme: Lob-Signature is the hex
 * HMAC-SHA256 of `${Lob-Signature-Timestamp}.${raw body}`; stale
 * timestamps are rejected to bound replays.
 */

const express = require('express');
const crypto  = require('crypto');
const config  = require('../config');
const logger  = require('../logger');

const router = express.Router();

const LOB_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function _isProduction() {
  return process.env.NODE_ENV === 'production';
}

function _safeEqualHex(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false; // length mismatch → invalid
  }
}

// ── Generic HMAC-SHA256 over the exact raw request bytes ─────────────────────
function validateHMAC(secret, rawBody, signature) {
  if (!secret) {
    if (_isProduction()) return false; // fail closed: production requires a secret
    return true; // explicit non-production bypass — no secret configured
  }
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return _safeEqualHex(signature, expected);
}

// ── Lob signature: HMAC-SHA256 of `${timestamp}.${raw body}` ─────────────────
function validateLobSignature(secret, rawBody, timestamp, signature) {
  if (!secret) {
    if (_isProduction()) return false;
    return true; // explicit non-production bypass — no secret configured
  }
  if (!signature || !timestamp || !Buffer.isBuffer(rawBody)) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > LOB_TIMESTAMP_TOLERANCE_MS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  return _safeEqualHex(signature, expected);
}

function parseJSON(rawBody) {
  if (Buffer.isBuffer(rawBody)) {
    try { return JSON.parse(rawBody.toString('utf8')); } catch { return null; }
  }
  return null;
}

// ── POST /webhooks/dxf/adt — Manifest MedEx ADT event ────────────────────────
// A01 = Admit, A02 = Transfer, A03 = Discharge
router.post('/dxf/adt', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.headers['x-medex-signature'] || '';

  if (!validateHMAC(config.webhooks.dxfSecret, req.body, sig)) {
    logger.warn({ msg: 'DxF ADT: HMAC validation failed', ip: req.ip });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = parseJSON(req.body);
  if (!event) return res.status(400).json({ error: 'Invalid JSON body' });

  logger.info({
    msg:            'DxF ADT event received',
    eventType:      event.eventType,
    claimNumber:    event.patientInternalId,
    facilityName:   event.facilityName,
    eventDateTime:  event.eventDateTime,
  });

  // TODO M5: queue.enqueue('ADTProcessingWorker', { event })
  //          → query clinical documents, update claim, set follow-up diary

  res.status(202).json({ received: true });
});

// ── POST /webhooks/enlyte/determination — UR determination ───────────────────
router.post('/enlyte/determination', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.headers['x-enlyte-signature'] || '';

  if (!validateHMAC(config.webhooks.enlyteSecret, req.body, sig)) {
    logger.warn({ msg: 'Enlyte determination: HMAC validation failed', ip: req.ip });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const determination = parseJSON(req.body);
  if (!determination) return res.status(400).json({ error: 'Invalid JSON body' });

  logger.info({
    msg:             'Enlyte UR determination received',
    referralId:      determination.referralId,
    claimNumber:     determination.claimNumber,
    determination:   determination.determination,
    imrRequired:     determination.imrRightsNoticeRequired,
  });

  // TODO M6:
  //   1. Update RFA status in DB
  //   2. Push determination letter to FileHandler (attachDocument)
  //   3. If imrRightsNoticeRequired: generate IMR notice, queue Lob.com
  //   4. Complete the UR deadline diary in FileHandler
  //   5. Notify worker and treating physician

  res.status(202).json({ received: true });
});

// ── POST /webhooks/lob/delivery — letter delivery events ─────────────────────
// Only a verified provider delivery event may move physical mail to
// delivered; processing is idempotent on Lob's event id (duplicate
// webhook deliveries are acknowledged without reprocessing).
router.post('/lob/delivery', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['lob-signature'] || '';
  const ts  = req.headers['lob-signature-timestamp'] || '';

  if (!validateLobSignature(config.webhooks.lobSecret, req.body, ts, sig)) {
    logger.warn({ msg: 'Lob delivery: signature validation failed', ip: req.ip });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = parseJSON(req.body);
  if (!event) return res.status(400).json({ error: 'Invalid JSON body' });

  logger.info({
    msg:         'Lob delivery event',
    eventId:     event.id,
    letterId:    event.body?.id || event.reference_id,
    eventType:   event.event_type?.id || event.event_type,
  });

  try {
    const delivery = require('../services/noticeDeliveryService');
    const result = await delivery.recordLobEvent(event);
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    logger.error({ msg: 'Lob delivery: event processing failed', err: err.message });
    // 500 → Lob retries; processing is idempotent so a retry is safe.
    res.status(500).json({ error: 'Event processing failed' });
  }
});

module.exports = router;
module.exports.validateHMAC = validateHMAC;
module.exports.validateLobSignature = validateLobSignature;
