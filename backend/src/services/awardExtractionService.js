'use strict';

/**
 * awardExtractionService.js — M14.5 Award Document Extraction.
 *
 * Extracts structured award fields from a WCAB Findings and Award (stip) or
 * Order Approving Compromise and Release (C&R) PDF using Claude's document
 * content block API.
 *
 * Writes an ai_decisions row (decision_type='award_extraction') for every call.
 *
 * If the extracted accruedStartDate is populated and claim.p_and_s_date is
 * NULL, the extraction write-throughs the P&S date via pdService.setPAndSDate
 * with source='award_document' (low priority — overwriteable by PR-4/QME).
 *
 * If claim.p_and_s_date is already set and disagrees with the extraction by
 * more than DISBURSEMENT_POLICY.P_AND_S_DISCREPANCY_DAYS, the return includes
 * P_AND_S_DISCREPANCY in its warnings[] array — disbursementService converts
 * that into a bundle flag.
 */

const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { supabase } = require('./supabase');
const logger       = require('../logger');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'; // sentinel for system-sourced P&S writes

// Lazy requires to break potential cycles.
function _getAiService() { return require('./aiService'); }
function _getPdService() { return require('./pdService'); }

const REQUIRED_KEYS = [
  'awardDate',
  'awardServiceDate',
  'accruedStartDate',
  'totalAward',
  'apportionmentPct',
  'weeklyRate',
  'aaFeePct',
  'aaFeeAmount',
  'commutationOrdered',
  'bodyPartsAwarded',
  'futureMedical',
  'rawExtractionConfidence',
  'notes',
];

function _loadPrompt() {
  const p = path.join(PROMPTS_DIR, 'award_extraction.txt');
  if (!fs.existsSync(p)) throw new Error(`Prompt file not found: ${p}`);
  return fs.readFileSync(p, 'utf8').trim();
}

function _daysBetween(iso1, iso2) {
  const d1 = new Date(iso1 + (iso1.includes('T') ? '' : 'T00:00:00'));
  const d2 = new Date(iso2 + (iso2.includes('T') ? '' : 'T00:00:00'));
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

function _normalize(raw) {
  // Ensure every required key is present; default missing to null or [] / false.
  const out = {};
  for (const k of REQUIRED_KEYS) {
    if (k in raw) {
      out[k] = raw[k];
    } else if (k === 'bodyPartsAwarded') {
      out[k] = [];
    } else if (k === 'commutationOrdered' || k === 'futureMedical') {
      out[k] = false;
    } else {
      out[k] = null;
    }
  }
  if (!Array.isArray(out.bodyPartsAwarded)) out.bodyPartsAwarded = [];
  if (typeof out.commutationOrdered !== 'boolean') out.commutationOrdered = !!out.commutationOrdered;
  if (typeof out.futureMedical !== 'boolean') out.futureMedical = !!out.futureMedical;
  if (out.rawExtractionConfidence == null) out.rawExtractionConfidence = 0;
  if (out.notes == null) out.notes = '';
  return out;
}

// ── extractAward ─────────────────────────────────────────────────────────────
async function extractAward({ claimId, pdfBuffer, awardType }) {
  if (!claimId)   throw new Error('claimId is required');
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) throw new Error('pdfBuffer must be a Buffer');
  if (!['stip_f_and_a', 'cnr_oacr'].includes(awardType)) {
    throw new Error(`awardType must be 'stip_f_and_a' or 'cnr_oacr' — got ${awardType}`);
  }

  const systemPrompt = _loadPrompt();
  const instruction  = `awardType: ${awardType}. Extract all fields from the attached PDF and return valid JSON only.`;
  const promptHash   = crypto.createHash('sha256').update(systemPrompt).digest('hex');

  let rawResult;
  try {
    rawResult = await _getAiService()._callClaudeWithDocument(systemPrompt, pdfBuffer, instruction, 2000);
  } catch (err) {
    logger.error({ msg: 'awardExtractionService: Claude call failed', err: err.message, claimId });
    throw new Error('EXTRACTION_FAILED');
  }

  if (!rawResult || typeof rawResult !== 'object') {
    throw new Error('EXTRACTION_FAILED');
  }

  const normalized = _normalize(rawResult);
  const warnings   = [];

  // Audit: write ai_decisions row.
  try {
    await supabase.from('ai_decisions').insert({
      claim_id:           claimId,
      decision_type:      'award_extraction',
      model_used:         require('../config').anthropic.model,
      system_prompt_hash: promptHash,
      input_snapshot:     { awardType, pdfBytes: pdfBuffer.length },
      output_raw:         JSON.stringify(rawResult),
      output_parsed:      normalized,
      confidence:         Math.max(0, Math.min(100, parseInt(normalized.rawExtractionConfidence, 10) || 0)),
      recommendation:     null,
      created_at:         new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'awardExtractionService: ai_decisions insert failed (non-fatal)', err: err.message });
  }

  // P&S write-through / discrepancy detection.
  if (normalized.accruedStartDate) {
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    if (claim) {
      if (!claim.p_and_s_date) {
        try {
          await _getPdService().setPAndSDate(claimId, {
            date:        normalized.accruedStartDate,
            source:      'award_document',
            confirmedBy: SYSTEM_USER_ID,
          });
        } catch (err) {
          logger.error({ msg: 'awardExtractionService: setPAndSDate failed (non-fatal)', err: err.message });
        }
      } else {
        const diffDays = Math.abs(_daysBetween(claim.p_and_s_date, normalized.accruedStartDate));
        if (diffDays > 3) {
          warnings.push('P_AND_S_DISCREPANCY');
        }
      }
    }
  }

  logger.info({
    msg: 'awardExtractionService.extractAward: complete',
    claimId, awardType, confidence: normalized.rawExtractionConfidence, warnings,
  });

  return { ...normalized, warnings };
}

module.exports = {
  extractAward,
};
