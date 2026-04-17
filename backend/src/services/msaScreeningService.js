'use strict';

/**
 * msaScreeningService.js — M19 MSA (Medicare Set-Aside) Screening.
 *
 * Gate logic per Master_Context:
 *   MSA required if:
 *     - Medicare eligible (65+ or SSDI) AND settlement >$25,000
 *     - OR likely eligible within 30 years (age 35+) AND settlement >$250,000
 *   → required: C&R blocked, stip only
 *
 * MUST be called before any C&R offer — M14 will enforce this.
 * ssdi_receiving pulled from employees table (M6 retrofit field).
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

function _getClaimService() { return require('./claimService'); }

// ── MSA threshold constants ──────────────────────────────────────────────────
const MSA_THRESHOLDS = {
  MEDICARE_ELIGIBLE_SETTLEMENT: 25_000,
  LIKELY_ELIGIBLE_SETTLEMENT:   250_000,
  MEDICARE_AGE:                 65,
  LIKELY_ELIGIBLE_MIN_AGE:      35,
};

// ═════════════════════════════════════════════════════════════════════════════
// screenMSA
// ═════════════════════════════════════════════════════════════════════════════

async function screenMSA(claimId, projectedSettlementValue) {
  const claimService = _getClaimService();
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const emp = claim.employee || {};
  const settlement = parseFloat(projectedSettlementValue) || 0;

  // Compute age at screening
  let ageAtScreening = null;
  if (emp.dob) {
    const dob = new Date(emp.dob + 'T00:00:00');
    const now = new Date();
    ageAtScreening = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) ageAtScreening--;
  }

  // Pull ssdi_receiving from employees table
  let ssdiReceiving = false;
  if (emp.adpEmployeeId) {
    const { data: empRow } = await supabase
      .from('employees').select('ssdi_receiving')
      .eq('adp_employee_id', emp.adpEmployeeId).single();
    if (empRow) ssdiReceiving = empRow.ssdi_receiving || false;
  }

  // Medicare eligibility determination
  const isMedicareAge = ageAtScreening != null && ageAtScreening >= MSA_THRESHOLDS.MEDICARE_AGE;
  const medicareEligible = isMedicareAge || ssdiReceiving;

  let medicareEligibilityReason = null;
  if (isMedicareAge && ssdiReceiving) {
    medicareEligibilityReason = `Age ${ageAtScreening} (≥65) and receiving SSDI`;
  } else if (isMedicareAge) {
    medicareEligibilityReason = `Age ${ageAtScreening} (≥65)`;
  } else if (ssdiReceiving) {
    medicareEligibilityReason = 'Receiving SSDI';
  }

  // MSA gate evaluation
  let msaRequired = false;
  let msaRequiredReason = null;

  if (medicareEligible && settlement > MSA_THRESHOLDS.MEDICARE_ELIGIBLE_SETTLEMENT) {
    msaRequired = true;
    msaRequiredReason = `Medicare eligible (${medicareEligibilityReason}) and projected settlement $${settlement.toLocaleString()} exceeds $${MSA_THRESHOLDS.MEDICARE_ELIGIBLE_SETTLEMENT.toLocaleString()} threshold`;
  } else if (ageAtScreening != null && ageAtScreening >= MSA_THRESHOLDS.LIKELY_ELIGIBLE_MIN_AGE && settlement > MSA_THRESHOLDS.LIKELY_ELIGIBLE_SETTLEMENT) {
    msaRequired = true;
    msaRequiredReason = `Age ${ageAtScreening} (≥35, likely Medicare eligible within 30 years) and projected settlement $${settlement.toLocaleString()} exceeds $${MSA_THRESHOLDS.LIKELY_ELIGIBLE_SETTLEMENT.toLocaleString()} threshold`;
  }

  // Write screening row
  const { data: row, error } = await supabase
    .from('msa_screenings')
    .insert({
      claim_id:                  claimId,
      screened_at:               new Date().toISOString(),
      medicare_eligible:         medicareEligible,
      medicare_eligibility_reason: medicareEligibilityReason,
      age_at_screening:          ageAtScreening,
      ssdi_receiving:            ssdiReceiving,
      projected_settlement_value: settlement,
      msa_required:              msaRequired,
      msa_required_reason:       msaRequiredReason,
    })
    .select()
    .single();

  if (error) throw new Error(`msaScreeningService: insert failed — ${error.message}`);

  logger.info({
    msg: 'msaScreeningService.screenMSA: complete',
    claimId, msaRequired, ageAtScreening, ssdiReceiving, settlement,
  });

  return {
    required:    msaRequired,
    reason:      msaRequiredReason || 'MSA not required — C&R may proceed',
    screeningId: row.id,
    screening:   row,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Read
// ═════════════════════════════════════════════════════════════════════════════

async function getScreeningsForClaim(claimId) {
  const { data, error } = await supabase
    .from('msa_screenings').select('*').eq('claim_id', claimId)
    .order('screened_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  screenMSA,
  getScreeningsForClaim,
  MSA_THRESHOLDS,
};
