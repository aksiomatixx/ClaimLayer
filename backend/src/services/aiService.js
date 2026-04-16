'use strict';

/**
 * AI Service — Claude API integration.
 *
 * All prompts live in backend/prompts/*.txt so they can be edited without
 * a code deploy (per integrations.md).
 *
 * Every call logs input/output token counts for cost tracking and audit.
 * If Claude returns non-JSON, we throw — never silently fall through or
 * auto-approve anything on a parse failure (per integrations.md).
 */

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const logger = require('../logger');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

// ── Prompt loader ─────────────────────────────────────────────────────────────
function loadPrompt(name) {
  const filePath = path.join(PROMPTS_DIR, `${name}.txt`);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
}

// ── Core Claude call ──────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens = 1500) {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — AI analysis unavailable');
  }

  const start = Date.now();

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      config.anthropic.model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }],
    },
    {
      timeout: 45_000,
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
      },
    }
  );

  const raw = res.data.content?.find(b => b.type === 'text')?.text || '';

  logger.info({
    integration:  'anthropic',
    model:        config.anthropic.model,
    latencyMs:    Date.now() - start,
    inputTokens:  res.data.usage?.input_tokens,
    outputTokens: res.data.usage?.output_tokens,
  });

  // Strip accidental markdown fences before parsing
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    logger.error({ msg: 'Claude: JSON parse failed — manual review required', raw });
    throw new Error('Claude returned invalid JSON — task queued for manual review');
  }
}

// ── Compensability analysis ───────────────────────────────────────────────────

/**
 * Analyse a new claim and return:
 *   compensability, compensabilityScore, priority,
 *   suggestedMedicalReserve, suggestedIndemnityReserve, suggestedExpenseReserve,
 *   redFlags, nextActions, rationale
 */
async function analyzeCompensability(claim) {
  const systemPrompt = loadPrompt('compensability_analysis');

  const userContent = JSON.stringify({
    claimNumber:        claim.claimNumber,
    dateOfInjury:       claim.dateOfInjury,
    bodyPart:           claim.bodyPart,
    injuryType:         claim.injuryType,
    injuryDescription:  claim.injuryDescription,
    jobTitle:           claim.employee.jobTitle,
    aww:                claim.aww,
    tdRate:             claim.tdRate,
    stateOfJurisdiction: 'CA',
    employerContests:   claim.employerContests   ?? false,
    motorVehicleFields: claim.motorVehicleFields ?? null,
  });

  const result = await callClaude(systemPrompt, userContent);

  // Validate required output fields
  const required = [
    'compensability',
    'compensabilityScore',
    'priority',
    'suggestedMedicalReserve',
    'suggestedIndemnityReserve',
    'suggestedExpenseReserve',
  ];
  const missing = required.filter(f => !(f in result));
  if (missing.length) {
    throw new Error(`Claude compensability response missing fields: ${missing.join(', ')}`);
  }

  return result;
}

// ── RFA / MTUS evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a Request for Authorization against MTUS guidelines.
 * Returns: { recommendedAction, mtusConsistency, rationale, urgency, requiresIMRNotice, notes }
 *
 * CRITICAL: AI may only return 'auto_approve'. Denials always return 'physician_review'.
 */
async function evaluateRFA(rfa, claim) {
  const systemPrompt = loadPrompt('rfa_mtus_evaluation');

  const daysSinceInjury = Math.floor(
    (Date.now() - new Date(claim.dateOfInjury).getTime()) / (1000 * 60 * 60 * 24)
  );

  const userContent = JSON.stringify({
    claimNumber:          claim.claimNumber,
    dateOfInjury:         claim.dateOfInjury,
    daysSinceInjury,
    bodyPart:             claim.bodyPart,
    acceptedDiagnosis:    rfa.acceptedDiagnosis,
    requestedTreatment:   rfa.requestedTreatment,
    requestedCptCodes:    rfa.requestedCptCodes,
    requestingPhysician:  rfa.requestingPhysician,
    rfaReceivedDate:      rfa.rfaReceivedDate,
    stateOfJurisdiction:  'CA',
  });

  const result = await callClaude(systemPrompt, userContent, 1000);

  // Safety guard: AI must never return a denial
  if (result.recommendedAction && result.recommendedAction !== 'auto_approve' && result.recommendedAction !== 'physician_review') {
    logger.error({ msg: 'Claude RFA: unexpected recommendedAction', value: result.recommendedAction });
    result.recommendedAction = 'physician_review';
  }

  return result;
}

module.exports = {
  analyzeCompensability,
  evaluateRFA,
  _callClaude: callClaude, // exported for voiceService structured extraction
};
