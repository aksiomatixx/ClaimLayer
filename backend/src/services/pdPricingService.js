'use strict';

/**
 * pdPricingService.js — M19 Settlement Pricing.
 *
 * priceCnr: AI-priced via Claude. Uses stip value as floor.
 * compareOffers: returns both values + guardrail flags.
 *
 * C&R guardrails per Master_Context:
 *   cnrValue < stipValue × 1.15 → DONT_OFFER_CNR
 *   cnrValue > stipValue × 5    → REQUIRES_ADJUSTER_REVIEW
 *   Otherwise                   → CNR_VIABLE
 *
 * Does NOT duplicate PDRS logic — stip value comes from pdService.calculateStipValue.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

function _getClaimService()  { return require('./claimService'); }
function _getPdService()     { return require('./pdService'); }
function _getAiService()     { return require('./aiService'); }
function _getMsaService()    { return require('./msaScreeningService'); }

// ── C&R guardrail thresholds ─────────────────────────────────────────────────
const CNR_GUARDRAILS = {
  MIN_PREMIUM_MULTIPLIER: 1.15,  // C&R must be ≥115% of stip to be worth offering
  MAX_PREMIUM_MULTIPLIER: 5.0,   // C&R >500% of stip → adjuster review required
  MIN_PREMIUM_DOLLAR:     2500,  // Alternative: C&R must exceed stip by at least $2,500
};

// ═════════════════════════════════════════════════════════════════════════════
// priceCnr — AI-priced via Claude
// ═════════════════════════════════════════════════════════════════════════════

async function priceCnr(claimId) {
  const claimService = _getClaimService();
  const pdService    = _getPdService();
  const aiService    = _getAiService();

  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  // M14: MSA gate — C&R is blocked when MSA is required. Must screen first.
  const { data: msaRows } = await supabase
    .from('msa_screenings').select('*').eq('claim_id', claimId)
    .order('screened_at', { ascending: false });
  const latestMsa = (msaRows && msaRows.length > 0) ? msaRows[0] : null;
  if (!latestMsa) {
    throw new Error('MSA_SCREENING_REQUIRED_BEFORE_CNR_PRICING');
  }
  if (latestMsa.msa_required) {
    throw new Error('CNR_BLOCKED_MSA_REQUIRED');
  }

  // Get stip value from existing PD math (no duplication)
  const stipData = await pdService.calculateStipValue(claimId);

  const emp = claim.employee || {};

  // Compute worker age
  let workerAge = null;
  if (emp.dob) {
    const dob = new Date(emp.dob + 'T00:00:00');
    const now = new Date();
    workerAge = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) workerAge--;
  }

  const claimSnapshot = {
    claimNumber:     claim.claimNumber,
    dateOfInjury:    claim.dateOfInjury,
    bodyPart:        claim.bodyPart,
    injuryType:      claim.injuryType,
    status:          claim.status,
    aww:             claim.aww,
    tdRate:          claim.tdRate,
    workerAge,
    workerJobTitle:  emp.jobTitle,
    wpi:             stipData.wpi,
    pdPercent:       stipData.pdPercent,
    stipValue:       stipData.stipValue,
    apportionmentPercent: stipData.apportionmentPercent,
    claimAgeDays:    Math.floor((Date.now() - new Date(claim.dateOfInjury).getTime()) / (1000 * 60 * 60 * 24)),
  };

  const systemPrompt = _loadPrompt();
  // Prefer the metadata-returning helper, but fall back to plain
  // _callClaude so existing test doubles (which only mock _callClaude)
  // keep working without modification.
  let result, raw = null, meta = { input_tokens: null, output_tokens: null, latency_ms: null };
  if (typeof aiService._callClaudeMeta === 'function') {
    const out = await aiService._callClaudeMeta(systemPrompt, JSON.stringify(claimSnapshot), 1500);
    result = out.parsed; raw = out.raw; meta = out.meta;
  } else {
    result = await aiService._callClaude(systemPrompt, JSON.stringify(claimSnapshot), 1500);
  }

  // Safety: recommendation must always be adjuster_review
  if (result.recommendation && result.recommendation !== 'adjuster_review') {
    logger.error({ msg: 'pdPricingService: AI returned non-adjuster recommendation', value: result.recommendation });
    result.recommendation = 'adjuster_review';
  }

  // Use midpoint as the cnr value
  const cnrValue = parseFloat(result.cnrValueMid) || stipData.stipValue * 1.5;

  // Guardrail capture — always emit BOTH cap rules so the audit row is
  // explicit about which thresholds passed and which fired.
  const stip       = stipData.stipValue || 0;
  const premiumMul = stip > 0 ? cnrValue / stip : 0;
  const guardrails = [];
  if (premiumMul > CNR_GUARDRAILS.MAX_PREMIUM_MULTIPLIER) {
    guardrails.push({ rule: 'cnr_premium_cap_5x', triggered: true,
      action: 'rejected', computed_premium: Math.round(premiumMul * 100) / 100 });
  } else {
    guardrails.push({ rule: 'cnr_premium_cap_5x', triggered: false,
      computed_premium: Math.round(premiumMul * 100) / 100 });
  }
  if (premiumMul > CNR_GUARDRAILS.MIN_PREMIUM_MULTIPLIER) {
    guardrails.push({ rule: 'cnr_premium_cap_1.15x', triggered: true,
      action: 'flagged_above_premium_threshold',
      computed_premium: Math.round(premiumMul * 100) / 100 });
  } else {
    guardrails.push({ rule: 'cnr_premium_cap_1.15x', triggered: false,
      computed_premium: Math.round(premiumMul * 100) / 100 });
  }

  try {
    const aid = require('./aiDecisionsService');
    await aid.logDecision({
      claim_id:       claimId,
      decision_type:  'cnr_pricing',
      prompt_name:    'cnr_pricing',
      model:          require('../config').anthropic.model,
      input_snapshot: claimSnapshot,
      output_parsed:  result,
      output_raw:     raw,
      ...meta,
      confidence:        typeof result.confidence === 'number' ? result.confidence : null,
      guardrail_actions: guardrails,
    });
  } catch (e) { logger.warn({ msg: 'priceCnr: audit log failed', err: e.message }); }

  // Write settlement_offers row
  const { data: offer, error } = await supabase
    .from('settlement_offers')
    .insert({
      claim_id:         claimId,
      offer_type:       'cnr',
      stip_value:       stipData.stipValue,
      cnr_value:        cnrValue,
      cnr_premium_pct:  stipData.stipValue > 0
        ? Math.round((cnrValue / stipData.stipValue - 1) * 10000) / 100
        : null,
      pricing_method:   'claude_ai',
      msa_screening_id: latestMsa.id,
      status:           'draft',
      created_at:       new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`pdPricingService.priceCnr: insert failed — ${error.message}`);

  logger.info({ msg: 'pdPricingService.priceCnr: complete', claimId, stipValue: stipData.stipValue, cnrValue });

  return {
    offerId:     offer.id,
    stipValue:   stipData.stipValue,
    cnrValue,
    cnrValueLow:  parseFloat(result.cnrValueLow) || cnrValue * 0.8,
    cnrValueHigh: parseFloat(result.cnrValueHigh) || cnrValue * 1.2,
    premiumPct:   offer.cnr_premium_pct,
    rationale:    result.rationale || '',
    riskFactors:  result.riskFactors || [],
    futureMedicalEstimate: parseFloat(result.futureMedicalEstimate) || 0,
    recommendation: 'adjuster_review',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// compareOffers — stip vs C&R with guardrail flags
// ═════════════════════════════════════════════════════════════════════════════

async function compareOffers(claimId) {
  const pdService = _getPdService();

  const stipData = await pdService.calculateStipValue(claimId);
  const stipValue = stipData.stipValue;

  // Get latest C&R offer
  const { data: cnrOffers } = await supabase
    .from('settlement_offers')
    .select('*')
    .eq('claim_id', claimId)
    .eq('offer_type', 'cnr')
    .order('created_at', { ascending: false });

  const latestCnr = (cnrOffers && cnrOffers.length > 0) ? cnrOffers[0] : null;
  const cnrValue = latestCnr ? parseFloat(latestCnr.cnr_value) : null;

  // Guardrail evaluation
  let flag = null;
  let flagReason = null;

  if (cnrValue == null) {
    flag = 'NO_CNR_PRICED';
    flagReason = 'No C&R pricing available — run priceCnr first';
  } else if (cnrValue < stipValue * CNR_GUARDRAILS.MIN_PREMIUM_MULTIPLIER && cnrValue < stipValue + CNR_GUARDRAILS.MIN_PREMIUM_DOLLAR) {
    flag = 'DONT_OFFER_CNR';
    flagReason = `C&R value ($${cnrValue.toLocaleString()}) is less than ${CNR_GUARDRAILS.MIN_PREMIUM_MULTIPLIER * 100}% of stip ($${stipValue.toLocaleString()}) and less than stip + $${CNR_GUARDRAILS.MIN_PREMIUM_DOLLAR.toLocaleString()}. Not worth offering.`;
  } else if (cnrValue > stipValue * CNR_GUARDRAILS.MAX_PREMIUM_MULTIPLIER) {
    flag = 'REQUIRES_ADJUSTER_REVIEW';
    flagReason = `C&R value ($${cnrValue.toLocaleString()}) exceeds ${CNR_GUARDRAILS.MAX_PREMIUM_MULTIPLIER * 100}% of stip ($${stipValue.toLocaleString()}). Adjuster review required before offering.`;
  } else {
    flag = 'CNR_VIABLE';
    flagReason = `C&R value ($${cnrValue.toLocaleString()}) is within acceptable range of stip ($${stipValue.toLocaleString()}).`;
  }

  return {
    claimId,
    stipValue,
    cnrValue,
    cnrPremiumPct: cnrValue != null && stipValue > 0
      ? Math.round((cnrValue / stipValue - 1) * 10000) / 100
      : null,
    flag,
    flagReason,
    cnrOfferId: latestCnr?.id || null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Read operations
// ═════════════════════════════════════════════════════════════════════════════

async function getSettlementOffers(claimId) {
  const { data, error } = await supabase
    .from('settlement_offers')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Prompt loader ────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

function _loadPrompt() {
  const filePath = path.join(__dirname, '../../prompts/cnr_pricing.txt');
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
}

module.exports = {
  priceCnr,
  compareOffers,
  getSettlementOffers,
  CNR_GUARDRAILS,
};
