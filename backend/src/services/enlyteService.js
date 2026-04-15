'use strict';

/**
 * Enlyte (Mitchell) URO stub — M7.
 *
 * All URO routing in M7 is mocked. The real Enlyte API integration is
 * deferred to M8 once credentials are provisioned.
 *
 * Both functions return the same shape as the real API will return so that
 * rfaService.js does not need to change when the real integration lands.
 */

const logger = require('../logger');

/**
 * Submit an RFA to Enlyte for Independent Utilization Review (URO/IMR).
 *
 * @param {object} rfa      - RFA row from the rfas table
 * @param {object} claim    - Claim object (from claimService)
 * @param {string} reason   - Why it is being sent to URO
 * @returns {Promise<{ referralId: string, status: string, estimatedResponseAt: string }>}
 */
async function submitReferral(rfa, claim, reason) {
  const referralId = `ENL-MOCK-${Date.now()}`;

  logger.info({
    msg:        'enlyteService.submitReferral: stub — no real API call',
    referralId,
    rfaId:      rfa.id,
    claimId:    rfa.claim_id,
    reason,
  });

  // Simulate 72-hour turnaround for expedited, 5 business days for standard
  const hoursOut = rfa.urgency === 'expedited' ? 72 : 5 * 24;
  const estimatedResponseAt = new Date(Date.now() + hoursOut * 60 * 60 * 1000).toISOString();

  return {
    referralId,
    status:              'submitted',
    estimatedResponseAt,
  };
}

/**
 * Fetch the current determination status from Enlyte for a previously
 * submitted referral.
 *
 * @param {string} referralId - The Enlyte referral ID returned by submitReferral
 * @returns {Promise<{ referralId: string, status: string, determination: string|null }>}
 */
async function getReferralStatus(referralId) {
  logger.info({
    msg:        'enlyteService.getReferralStatus: stub — returning pending',
    referralId,
  });

  return {
    referralId,
    status:        'pending',
    determination: null,
  };
}

module.exports = { submitReferral, getReferralStatus };
