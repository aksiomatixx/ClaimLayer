'use strict';

/**
 * Webhook receivers for:
 *   • Manifest MedEx / DxF  →  /webhooks/dxf/adt
 *   • Enlyte UR              →  /webhooks/enlyte/determination
 *   • Lob.com delivery       →  /webhooks/lob/delivery
 *
 * HMAC validation is performed on raw bytes (express.raw) so we never
 * accidentally validate against a re-serialised body.
 * If no secret is configured (local dev / mocks), validation is skipped.
 */

const express = require('express');
const crypto  = require('crypto');
const config  = require('../config');
const logger  = require('../logger');

const router = express.Router();

// ── HMAC helper ───────────────────────────────────────────────────────────────
function validateHMAC(secret, rawBody, signature) {
  // Skip validation entirely outside production (test / mock servers don't sign)
  if (process.env.NODE_ENV !== 'production') return true;

  if (!secret || !signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch → invalid
  }
}

function parseJSON(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

// ── POST /webhooks/dxf/adt — Manifest MedEx ADT event ────────────────────────
// A01 = Admit, A02 = Transfer, A03 = Discharge
router.post('/dxf/adt', express.raw({ type: 'application/json' }), (req, res) => {
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
router.post('/enlyte/determination', express.raw({ type: 'application/json' }), (req, res) => {
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

// ── POST /webhooks/lob/delivery — Letter delivery confirmation ────────────────
// Lob uses its own signature scheme; validate using LOB_WEBHOOK_SECRET if set.
router.post('/lob/delivery', express.json(), (req, res) => {
  const event = req.body;

  logger.info({
    msg:         'Lob delivery event',
    letterId:    event.id,
    eventType:   event.event_type,
    claimNumber: event.metadata?.claim_id,
    noticeType:  event.metadata?.notice_type,
  });

  // TODO M8:
  //   1. Update notice.status → 'delivered' in DB
  //   2. Complete the relevant statutory-deadline diary in FileHandler

  res.status(200).json({ received: true });
});

module.exports = router;
