'use strict';

/**
 * Inbound Document Ingestion & Classification (Tier 1).
 *
 * The inbound half of the inversion: every arriving document is
 * classified by the document-classification agent, summarized, filed to
 * its claim, and translated into the action it requires — a diary the
 * adjuster sees as a prepared decision, never a raw PDF in an inbox.
 *
 * Pipeline guardrails (code, not prompts):
 *   - Classification confidence below CONFIDENCE_THRESHOLD → the document
 *     goes to the human triage queue. It is NEVER silently filed.
 *   - No confidently-extracted claim match → triage queue.
 *   - Category outside the controlled list → forced 'other' by aiService
 *     guardrail → triage queue.
 *   - Action translation is a deterministic rules table (DOC_ACTION_RULES),
 *     not a model output: what a work-status report *requires* is policy,
 *     and policy lives in code.
 *
 * Intake channels wired now: API upload (text content) and the legacy
 * adapter pull. Email-in and fax-in are channel adapters gated on vendor
 * accounts (Notice Delivery Orchestration shares the fax vendor).
 */

const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');
const { DOCUMENT_CATEGORIES } = require('../constants');

const CONFIDENCE_THRESHOLD = 70;

// ── Deterministic action translation ─────────────────────────────────────────
// category → the diary (prepared decision) it queues. due_days are calendar
// days from receipt. RFA receipt is CRITICAL: the §9792.9.1 UR clock starts
// at receipt, so it carries the tightest review window.
const DOC_ACTION_RULES = {
  rfa:            { diary_type: 'RFA_INTAKE_REVIEW',     due_days: 1,  priority: 'CRITICAL',
                    notes: 'RFA received — UR clock running (8 CCR §9792.9.1). Route to MTUS evaluation.' },
  work_status:    { diary_type: 'TD_PAYMENT_REVIEW',     due_days: 3,  priority: 'HIGH',
                    notes: 'Work status report received — confirm TD payment posture matches the new status.' },
  medical:        { diary_type: 'MED_REPORT_REVIEW',     due_days: 5,  priority: 'MEDIUM',
                    notes: 'Medical report received — review findings and treatment plan.' },
  qme:            { diary_type: 'QME_REPORT_REVIEW',     due_days: 3,  priority: 'HIGH',
                    notes: 'QME/AME document received — review and calendar any strike/response deadlines.' },
  legal:          { diary_type: 'LEGAL_REVIEW',          due_days: 2,  priority: 'HIGH',
                    notes: 'Legal document received — review for representation, liens, or WCAB deadlines.' },
  settlement:     { diary_type: 'SETTLEMENT_DOC_REVIEW', due_days: 3,  priority: 'HIGH',
                    notes: 'Settlement document received — reconcile against the open offer and MSA screen.' },
  wage:           { diary_type: 'AWW_RECALC_REVIEW',     due_days: 5,  priority: 'MEDIUM',
                    notes: 'Wage documentation received — verify AWW and TD rate.' },
  state_form:     { diary_type: 'STATE_FORM_REVIEW',     due_days: 2,  priority: 'MEDIUM',
                    notes: 'State form received — review and file.' },
  bill:           { diary_type: 'BILL_REVIEW',           due_days: 10, priority: 'LOW',
                    notes: 'Provider bill received — route to bill review.' },
  pharmacy:       { diary_type: 'BILL_REVIEW',           due_days: 10, priority: 'LOW',
                    notes: 'Pharmacy document received — route to bill review.' },
  surveillance:   { diary_type: 'SIU_REVIEW',            due_days: 5,  priority: 'HIGH',
                    notes: 'Surveillance material received — SIU review.' },
  correspondence: { diary_type: 'CORRESPONDENCE_REVIEW', due_days: 5,  priority: 'LOW',
                    notes: 'Correspondence received — review and respond if needed.' },
  other:          { diary_type: 'GENERAL_DOC_REVIEW',    due_days: 5,  priority: 'LOW',
                    notes: 'Unrecognized document filed — verify categorization.' },
};

// Signals refine the queued action beyond the base category rule.
const SIGNAL_OVERRIDES = {
  p_and_s:               { diary_type: 'PR4_RECEIVED_REVIEW', due_days: 3, priority: 'HIGH',
                           notes: 'P&S/MMI report received — review rating pathway (PR-4).' },
  representation_change: { diary_type: 'REPRESENTATION_REVIEW', due_days: 2, priority: 'HIGH',
                           notes: 'Representation change indicated — verify and update via the representation workflow (SROI 02 fires on change).' },
};

function _id() {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function _addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

async function _createDiary(claimId, rule, docId) {
  const row = {
    id:          `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id:    claimId,
    diary_type:  rule.diary_type,
    due_date:    _addDays(rule.due_days),
    assigned_to: config.adjuster.email,
    priority:    rule.priority,
    notes:       rule.notes,
    status:      'open',
    source_document_id: docId,
    created_at:  new Date().toISOString(),
  };
  await supabase.from('diaries').insert(row);
  return row;
}

async function _writeEvent(claimId, type, data) {
  await supabase.from('claim_events').insert({
    claim_id: claimId, type, timestamp: new Date().toISOString(), data,
  });
}

function _resolveRule(category, signals) {
  for (const sig of signals || []) {
    if (SIGNAL_OVERRIDES[sig]) return SIGNAL_OVERRIDES[sig];
  }
  return DOC_ACTION_RULES[category] || DOC_ACTION_RULES.other;
}

async function _matchClaimByNumber(claimNumber) {
  if (!claimNumber) return null;
  const { data } = await supabase
    .from('claims').select('id,claim_number').eq('claim_number', claimNumber).single();
  return data ? data.id : null;
}

/**
 * Ingest one inbound document.
 *
 * @param {object} input
 *   - title          display title (falls back to filename)
 *   - filename
 *   - content_text   extracted text of the document (required)
 *   - source         channel: 'upload' | 'email' | 'fax' | 'legacy_adapter' | ...
 *   - claim_id       optional — when the channel already knows the claim
 * @returns { document, diary|null, routed: 'filed'|'triage' }
 */
async function ingestDocument(input, actorEmail) {
  const { title, filename, content_text, source, claim_id } = input || {};
  if (!content_text || !String(content_text).trim()) {
    throw new Error('content_text is required — ingest the extracted document text');
  }

  const aiService = require('./aiService');
  const classification = await aiService.classifyDocument({
    text: content_text,
    filename,
    source,
    claimIdHint: claim_id || null,
  });

  const { category, confidence, summary, key_fields } = classification;
  const signals = key_fields?.signals || [];

  // Claim resolution: explicit channel claim wins; otherwise the agent's
  // verbatim-extracted claim number, verified against the claims table.
  let resolvedClaimId = claim_id || null;
  let matchBasis = claim_id ? 'channel' : null;
  if (!resolvedClaimId && classification.claim_number) {
    resolvedClaimId = await _matchClaimByNumber(classification.claim_number);
    matchBasis = resolvedClaimId ? 'extracted_claim_number' : null;
  }

  const lowConfidence = confidence < CONFIDENCE_THRESHOLD;
  const guardrailForced = (classification.guardrails || [])
    .some(g => g.rule === 'controlled_category_list' && g.triggered);
  const needsTriage = lowConfidence || !resolvedClaimId || guardrailForced;

  const now = new Date().toISOString();
  const doc = {
    id: _id(),
    claim_id: resolvedClaimId,
    title: title || filename || 'Untitled document',
    category,
    source: source || 'upload',
    received_at: now,
    pages: input.pages || null,
    status: needsTriage ? 'triage' : 'filed',
    ai_summary: summary,
    relevant_to: needsTriage ? [] : [_resolveRule(category, signals).diary_type],
    content_text: String(content_text),
    key_fields: key_fields || null,
    classification_confidence: confidence,
    classification_model: config.anthropic.model,
    triage_status: needsTriage ? 'pending' : 'none',
    triage_reason: needsTriage
      ? (guardrailForced ? 'category_guardrail'
        : lowConfidence ? `confidence_below_threshold (${confidence} < ${CONFIDENCE_THRESHOLD})`
        : 'no_claim_match')
      : null,
    version: 1,
    created_at: now,
    updated_at: now,
  };

  const { data: inserted, error } = await supabase
    .from('claim_documents').insert(doc).select().single();
  if (error) throw new Error(`documentIngestionService.ingestDocument: ${error.message}`);

  if (needsTriage) {
    logger.info({
      msg: 'documentIngestion: routed to human triage',
      docId: inserted.id, reason: doc.triage_reason, confidence,
    });
    return { document: inserted, diary: null, routed: 'triage' };
  }

  const rule = _resolveRule(category, signals);
  const diary = await _createDiary(resolvedClaimId, rule, inserted.id);
  await _writeEvent(resolvedClaimId, 'document_ingested', {
    document_id: inserted.id, category, confidence,
    diary_type: rule.diary_type, match_basis: matchBasis, actor: actorEmail || null,
  });

  return { document: inserted, diary, routed: 'filed' };
}

/** Pending human-triage queue, oldest first. */
async function listTriage() {
  const { data, error } = await supabase
    .from('claim_documents').select('*').eq('triage_status', 'pending');
  if (error) throw new Error(`documentIngestionService.listTriage: ${error.message}`);
  return (data || []).sort((a, b) =>
    String(a.received_at).localeCompare(String(b.received_at)));
}

/**
 * Human triage resolution: assign claim + category (or reject). Filing
 * through triage runs the same deterministic action translation as a
 * confident classification — the human supplies what the agent couldn't.
 */
async function resolveTriage(docId, { action, claim_id, category }, actorEmail) {
  const { data: doc } = await supabase
    .from('claim_documents').select('*').eq('id', docId).single();
  if (!doc) throw new Error(`Document not found: ${docId}`);
  if (doc.triage_status !== 'pending') throw new Error('Document is not pending triage');

  const now = new Date().toISOString();

  if (action === 'reject') {
    const { data: updated } = await supabase.from('claim_documents')
      .update({ status: 'rejected', triage_status: 'resolved', updated_at: now })
      .eq('id', docId).select().single();
    return { document: updated, diary: null };
  }

  if (action !== 'file') throw new Error("action must be 'file' or 'reject'");
  if (!claim_id) throw new Error('claim_id is required to file a triaged document');
  const finalCategory = category || doc.category;
  if (!DOCUMENT_CATEGORIES.includes(finalCategory)) {
    throw new Error(`category must be one of the controlled list: ${DOCUMENT_CATEGORIES.join(', ')}`);
  }
  const { data: claim } = await supabase.from('claims').select('id').eq('id', claim_id).single();
  if (!claim) throw new Error(`Claim not found: ${claim_id}`);

  const rule = _resolveRule(finalCategory, doc.key_fields?.signals);
  const { data: updated } = await supabase.from('claim_documents')
    .update({
      claim_id, category: finalCategory, status: 'filed',
      triage_status: 'resolved', relevant_to: [rule.diary_type], updated_at: now,
    })
    .eq('id', docId).select().single();

  const diary = await _createDiary(claim_id, rule, docId);
  await _writeEvent(claim_id, 'document_ingested', {
    document_id: docId, category: finalCategory, via: 'human_triage', actor: actorEmail || null,
  });

  return { document: updated, diary };
}

module.exports = {
  ingestDocument,
  listTriage,
  resolveTriage,
  CONFIDENCE_THRESHOLD,
  DOC_ACTION_RULES,
  SIGNAL_OVERRIDES,
};
