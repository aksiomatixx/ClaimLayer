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

const Anthropic = require('@anthropic-ai/sdk');
const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const logger = require('../logger');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

// Lazy singleton — constructed on first call so a missing key fails the call,
// not module load. The SDK retries 429/500/529 with exponential backoff.
let _client = null;
function getClient() {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — AI analysis unavailable');
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 3 });
  }
  return _client;
}

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
//
// Two flavors:
//   callClaude(...)      — returns parsed JSON (back-compat for existing callers).
//   callClaudeMeta(...)  — returns { parsed, raw, meta:{input_tokens, output_tokens, latency_ms} }
// for callers that want to log via aiDecisionsService.
async function callClaudeMeta(systemPrompt, userContent, maxTokens = 1500) {
  const client = getClient();

  const start = Date.now();

  const res = await client.messages.create(
    {
      model:      config.anthropic.model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }],
    },
    { timeout: 45_000 }
  );

  const raw = res.content?.find(b => b.type === 'text')?.text || '';
  const latency_ms = Date.now() - start;
  const input_tokens  = res.usage?.input_tokens  ?? null;
  const output_tokens = res.usage?.output_tokens ?? null;

  logger.info({
    integration: 'anthropic', model: config.anthropic.model,
    latencyMs: latency_ms, inputTokens: input_tokens, outputTokens: output_tokens,
  });

  // Strip accidental markdown fences before parsing
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    logger.error({ msg: 'Claude: JSON parse failed — manual review required', raw });
    throw new Error('Claude returned invalid JSON — task queued for manual review');
  }
  return { parsed, raw, meta: { input_tokens, output_tokens, latency_ms } };
}

async function callClaude(systemPrompt, userContent, maxTokens = 1500) {
  const { parsed } = await callClaudeMeta(systemPrompt, userContent, maxTokens);
  return parsed;
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

  const inputSnapshot = {
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
  };

  const { parsed: result, raw, meta } = await callClaudeMeta(systemPrompt, JSON.stringify(inputSnapshot));

  // Validate required output fields
  const required = [
    'compensability', 'compensabilityScore', 'priority',
    'suggestedMedicalReserve', 'suggestedIndemnityReserve', 'suggestedExpenseReserve',
  ];
  const missing = required.filter(f => !(f in result));
  if (missing.length) {
    throw new Error(`Claude compensability response missing fields: ${missing.join(', ')}`);
  }

  // Audit log — best-effort; never breaks the AI return
  try {
    const aid = require('./aiDecisionsService');
    await aid.logDecision({
      claim_id:       claim.id || null,
      decision_type:  'compensability',
      prompt_name:    'compensability_analysis',
      model:          config.anthropic.model,
      input_snapshot: inputSnapshot,
      output_parsed:  result,
      output_raw:     raw,
      ...meta,
      confidence:     typeof result.compensabilityScore === 'number' ? result.compensabilityScore : null,
      guardrail_actions: [],
    });
  } catch (e) { logger.warn({ msg: 'analyzeCompensability: audit log failed', err: e.message }); }

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

  const inputSnapshot = {
    claimNumber:         claim.claimNumber,
    dateOfInjury:        claim.dateOfInjury,
    daysSinceInjury,
    bodyPart:            claim.bodyPart,
    acceptedDiagnosis:   rfa.acceptedDiagnosis,
    requestedTreatment:  rfa.requestedTreatment,
    requestedCptCodes:   rfa.requestedCptCodes,
    requestingPhysician: rfa.requestingPhysician,
    rfaReceivedDate:     rfa.rfaReceivedDate,
    stateOfJurisdiction: 'CA',
  };

  const { parsed: result, raw, meta } = await callClaudeMeta(systemPrompt, JSON.stringify(inputSnapshot), 1000);

  // Safety guard: AI must never return a denial
  const guardrails = [];
  const original = result.recommendedAction;
  const validActions = ['auto_approve', 'physician_review'];
  if (original && !validActions.includes(original)) {
    logger.error({ msg: 'Claude RFA: unexpected recommendedAction', value: original });
    result.recommendedAction = 'physician_review';
    guardrails.push({
      rule: 'no_auto_deny', triggered: true,
      original, forced_to: 'physician_review',
    });
  } else {
    // Always emit the rule with triggered:false so the audit is explicit
    guardrails.push({ rule: 'no_auto_deny', triggered: false });
  }

  try {
    const aid = require('./aiDecisionsService');
    await aid.logDecision({
      claim_id:       claim.id || null,
      decision_type:  'rfa_mtus',
      prompt_name:    'rfa_mtus_evaluation',
      model:          config.anthropic.model,
      input_snapshot: inputSnapshot,
      output_parsed:  result,
      output_raw:     raw,
      ...meta,
      confidence:        typeof result.confidence === 'number' ? result.confidence : null,
      guardrail_actions: guardrails,
    });
  } catch (e) { logger.warn({ msg: 'evaluateRFA: audit log failed', err: e.message }); }

  return result;
}

// ── Claude call with PDF document block (M14.5 award extraction) ─────────────

/**
 * Send a PDF document plus a text instruction to Claude and return parsed JSON.
 * Used by awardExtractionService for WCAB Findings & Award / OACR PDFs.
 *
 * Does NOT change the existing callClaude signature.
 */
async function callClaudeWithDocument(systemPrompt, pdfBuffer, userInstruction, maxTokens = 2000) {
  const client = getClient();
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error('callClaudeWithDocument: pdfBuffer must be a Buffer');
  }

  const start = Date.now();

  const res = await client.messages.create(
    {
      model:      config.anthropic.model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type:   'document',
            source: {
              type:       'base64',
              media_type: 'application/pdf',
              data:       pdfBuffer.toString('base64'),
            },
          },
          { type: 'text', text: userInstruction },
        ],
      }],
    },
    { timeout: 60_000 }
  );

  const raw = res.content?.find(b => b.type === 'text')?.text || '';

  logger.info({
    integration:  'anthropic',
    mode:         'document',
    model:        config.anthropic.model,
    latencyMs:    Date.now() - start,
    inputTokens:  res.usage?.input_tokens,
    outputTokens: res.usage?.output_tokens,
  });

  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    logger.error({ msg: 'Claude: document JSON parse failed — manual review required', raw });
    throw new Error('Claude returned invalid JSON — task queued for manual review');
  }
}

module.exports = {
  analyzeCompensability,
  evaluateRFA,
  _callClaude:             callClaude,             // exported for voiceService structured extraction
  _callClaudeMeta:         callClaudeMeta,         // exported for callers that want token + latency metadata
  _callClaudeWithDocument: callClaudeWithDocument, // exported for awardExtractionService (M14.5)
};
