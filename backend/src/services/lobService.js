'use strict';

/**
 * lobService.js — Lob.com print & mail stub — M9.
 *
 * All mailing in M9 is mocked.  The real Lob API integration is deferred
 * until LOB_LIVE=true is set in the environment and a live LOB_API_KEY is
 * provisioned.
 *
 * Both functions return the same shape as the real Lob API will return so
 * that noticeService.js does not need to change when the real integration
 * lands.  To switch to production: set LOB_LIVE=true — one-line flag swap.
 */

const config = require('../config');
const logger  = require('../logger');

const LOB_LIVE = process.env.LOB_LIVE === 'true';

/**
 * Queue a letter for print & mail via Lob.com.
 *
 * @param {string} noticeType    - e.g. 'dwc7', 'td_benefit', 'rfa_determination', 'imr_rights', 'denial'
 * @param {string} claimId       - Claim ID this notice belongs to
 * @param {string} recipientRole - 'claimant' | 'employer' | 'attorney' | 'provider'
 * @param {object} payload       - { recipientName, recipientAddress, pdfBuffer }
 * @returns {Promise<{ letterId: string, status: string, estimatedDelivery: string }>}
 */
async function sendLetter(noticeType, claimId, recipientRole, payload) {
  if (LOB_LIVE && config.lob.apiKey) {
    // Real Lob API call — deferred until LOB_LIVE=true in production
    throw new Error('lobService: LOB_LIVE=true but real Lob integration is not yet implemented. Set LOB_LIVE=false for stub mode.');
  }

  const letterId = `ltr_MOCK-${Date.now()}`;

  logger.info({
    msg:           'lobService.sendLetter: stub — no real API call',
    letterId,
    noticeType,
    claimId,
    recipientRole,
    recipientName: payload?.recipientName,
  });

  // Simulate 3-5 business day delivery window
  const deliveryDays = 4;
  const estimatedDelivery = new Date(Date.now() + deliveryDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  return {
    letterId,
    status:            'queued',
    estimatedDelivery,
  };
}

/**
 * Fetch the current delivery status of a previously submitted letter.
 *
 * @param {string} lobId - The Lob letter ID returned by sendLetter
 * @returns {Promise<{ letterId: string, status: string, expectedDelivery: string|null }>}
 */
async function getLetterStatus(lobId) {
  logger.info({
    msg:    'lobService.getLetterStatus: stub — returning in_transit',
    lobId,
  });

  return {
    letterId:         lobId,
    status:           'in_transit',
    expectedDelivery: null,
  };
}

module.exports = { sendLetter, getLetterStatus };
