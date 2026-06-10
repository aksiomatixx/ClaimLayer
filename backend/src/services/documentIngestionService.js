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

// Calendar days from an anchor timestamp (the authoritative channel
// receipt time — statutory clocks run from receipt, not from when the
// pipeline got around to processing).
function _addDays(fromIso, n) {
  const d = fromIso ? new Date(fromIso) : new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * The authoritative receipt timestamp: the channel's value when given
 * (validated ISO, not in the future), processing time otherwise.
 */
function _resolveReceivedAt(receivedAt) {
  if (!receivedAt) return new Date().toISOString();
  const t = Date.parse(receivedAt);
  if (Number.isNaN(t)) {
    throw new Error('received_at must be a valid ISO-8601 timestamp');
  }
  if (t - Date.now() > FUTURE_SKEW_MS) {
    throw new Error('received_at cannot be in the future');
  }
  return new Date(t).toISOString();
}

async function _createDiary(claimId, rule, docId, receivedAt) {
  const row = {
    id:          `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id:    claimId,
    diary_type:  rule.diary_type,
    // Deadlines anchor to RECEIPT (calendar days per the rules table) —
    // a document that sat in a fax queue for three days does not get
    // three extra days of statutory clock.
    due_date:    _addDays(receivedAt, rule.due_days),
    assigned_to: config.adjuster.email,
    priority:    rule.priority,
    notes:       rule.notes,
    status:      'open',
    source_document_id: docId,
    created_at:  new Date().toISOString(),
  };
  const { error } = await supabase.from('diaries').insert(row);
  if (error) throw new Error(`diary insert failed: ${error.message}`);
  return row;
}

async function _writeEvent(claimId, type, data) {
  const row = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id: claimId, type, timestamp: new Date().toISOString(), data,
  };
  const { error } = await supabase.from('claim_events').insert(row);
  if (error) throw new Error(`event insert failed: ${error.message}`);
  return row;
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

  // Authoritative channel receipt timestamp drives every deadline below.
  const receivedAt = _resolveReceivedAt(input.received_at);

  // An explicit channel claim id must point at a real claim — fail fast
  // (before the model call), never silently file against a bad id.
  if (claim_id) {
    const { data: claimRow, error: claimErr } = await supabase
      .from('claims').select('id').eq('id', claim_id).single();
    if (claimErr || !claimRow) {
      throw new Error(`claim_id does not match a known claim: ${claim_id}`);
    }
  }

  const aiService = require('./aiService');
  const classification = await aiService.classifyDocument({
    text: content_text,
    filename,
    source,
    claimIdHint: claim_id || null,
  });

  return _persistClassified({
    classification,
    receivedAt,
    explicitClaimId: claim_id || null,
    fields: {
      title: title || filename || 'Untitled document',
      source: source || 'upload',
      pages: input.pages || null,
      content_text: String(content_text),
    },
  }, actorEmail);
}

/**
 * The shared back half of ingestion (text and PDF paths converge here):
 * claim resolution → guardrail/triage routing → document insert →
 * the compensated document+diary+event filing unit.
 */
async function _persistClassified({ classification, receivedAt, explicitClaimId, fields }, actorEmail) {
  const { category, confidence, summary, key_fields } = classification;
  const signals = key_fields?.signals || [];

  // Claim resolution: explicit channel claim wins; otherwise the agent's
  // verbatim-extracted claim number, verified against the claims table.
  let resolvedClaimId = explicitClaimId || null;
  let matchBasis = explicitClaimId ? 'channel' : null;
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
    category,
    received_at: receivedAt,
    status: needsTriage ? 'triage' : 'filed',
    ai_summary: summary,
    relevant_to: needsTriage ? [] : [_resolveRule(category, signals).diary_type],
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
    ...fields,
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

  // Document + action diary + event are one unit: a failure after the
  // document insert compensates (removes the orphan) and surfaces the
  // error — a filed document without its prepared action would be a
  // silent inbox.
  let diary;
  try {
    const rule = _resolveRule(category, signals);
    diary = await _createDiary(resolvedClaimId, rule, inserted.id, receivedAt);
    try {
      await _writeEvent(resolvedClaimId, 'document_ingested', {
        document_id: inserted.id, category, confidence, received_at: receivedAt,
        diary_type: rule.diary_type, match_basis: matchBasis, actor: actorEmail || null,
      });
    } catch (e) {
      await supabase.from('diaries').delete().eq('id', diary.id);
      throw e;
    }
  } catch (e) {
    await supabase.from('claim_documents').delete().eq('id', inserted.id);
    logger.error({ msg: 'documentIngestion: filing unit failed — compensated', docId: inserted.id, err: e.message });
    throw new Error(`documentIngestionService.ingestDocument: filing failed and was rolled back — ${e.message}`);
  }

  return { document: inserted, diary, routed: 'filed' };
}

// ── PDF intake (Tier 1.5 #1) ─────────────────────────────────────────────────

const PDF_MAX_BYTES = 15 * 1024 * 1024;
// Below this many extracted characters the text layer is considered
// unusable (scanned/image PDF) and classification falls back to sending
// the document itself to the model as a document block.
const PDF_MIN_TEXT_CHARS = 120;

function _isPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 &&
    buffer.slice(0, 5).toString('latin1').startsWith('%PDF-');
}

/**
 * Extract the text layer from a PDF (pdfjs-dist legacy build — pure JS,
 * no native binaries). Returns { text, pages }. Extraction failures
 * return empty text rather than throwing: an unreadable text layer is
 * exactly the case the document-block fallback exists for.
 */
async function extractPdfText(buffer) {
  try {
    // The v3 legacy build is CommonJS (works under Jest's CJS VM, no
    // dynamic-ESM import needed). Render polyfill warnings on first
    // require are harmless — only text extraction is used.
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n';
    }
    return { text: text.trim(), pages: doc.numPages };
  } catch (e) {
    logger.warn({ msg: 'extractPdfText: extraction failed — document-block fallback will classify', err: e.message });
    return { text: '', pages: null };
  }
}

/**
 * Ingest an actual PDF file. Text-layer first: when the PDF carries a
 * usable text layer it runs through the exact text-classification path;
 * a scanned/image PDF (thin or failed extraction) falls back to
 * classifying the document itself via a Claude document block. Both
 * paths share every guardrail, the triage routing, and the
 * receipt-anchored deterministic action translation. The original PDF
 * is stored on the document so "open original" shows the real file.
 *
 * @param {object} input — { buffer, filename, title, source, claim_id,
 *                           received_at, channel_metadata }
 */
async function ingestPdf(input, actorEmail) {
  const { buffer, filename, title, source, claim_id } = input || {};
  if (!_isPdf(buffer)) {
    throw new Error('file must be a PDF (missing %PDF header)');
  }
  if (buffer.length > PDF_MAX_BYTES) {
    throw new Error(`PDF exceeds the ${Math.round(PDF_MAX_BYTES / 1024 / 1024)}MB intake limit`);
  }

  const receivedAt = _resolveReceivedAt(input.received_at);

  if (claim_id) {
    const { data: claimRow, error: claimErr } = await supabase
      .from('claims').select('id').eq('id', claim_id).single();
    if (claimErr || !claimRow) {
      throw new Error(`claim_id does not match a known claim: ${claim_id}`);
    }
  }

  const aiService = require('./aiService');
  const { text, pages } = await extractPdfText(buffer);

  let classification;
  let extractionMethod;
  if (text.length >= PDF_MIN_TEXT_CHARS) {
    extractionMethod = 'text_layer';
    classification = await aiService.classifyDocument({
      text, filename, source, claimIdHint: claim_id || null,
    });
  } else {
    extractionMethod = 'document_vision';
    logger.info({
      msg: 'ingestPdf: text layer unusable — classifying via document block',
      filename, extracted_chars: text.length,
    });
    classification = await aiService.classifyDocumentFromPdf({
      pdfBuffer: buffer, filename, source, claimIdHint: claim_id || null,
    });
  }

  return _persistClassified({
    classification,
    receivedAt,
    explicitClaimId: claim_id || null,
    fields: {
      title: title || filename || 'Untitled document',
      source: source || 'upload',
      pages: pages,
      content_text: text || null,
      pdf_buffer_b64: buffer.toString('base64'),
      extraction_method: extractionMethod,
      channel_metadata: input.channel_metadata || null,
    },
  }, actorEmail);
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
 * Human triage resolution: assign claim + category (or reject with a
 * documented reason). Filing through triage runs the same deterministic
 * action translation as a confident classification — the human supplies
 * what the agent couldn't.
 *
 * Atomic: the document is claimed pending → resolving with a
 * conditional update, so two adjusters cannot resolve the same
 * document; any failure inside the unit reverts it to pending.
 */
async function resolveTriage(docId, { action, claim_id, category, reason }, actorEmail) {
  const { data: doc, error: dErr } = await supabase
    .from('claim_documents').select('*').eq('id', docId).single();
  if (dErr || !doc) throw new Error(`Document not found: ${docId}`);
  if (doc.triage_status !== 'pending') throw new Error('Document is not pending triage');

  // Validate everything BEFORE claiming.
  if (!['file', 'reject'].includes(action)) throw new Error("action must be 'file' or 'reject'");
  let finalCategory = null;
  let rule = null;
  if (action === 'file') {
    if (!claim_id) throw new Error('claim_id is required to file a triaged document');
    finalCategory = category || doc.category;
    if (!DOCUMENT_CATEGORIES.includes(finalCategory)) {
      throw new Error(`category must be one of the controlled list: ${DOCUMENT_CATEGORIES.join(', ')}`);
    }
    const { data: claim, error: cErr } = await supabase
      .from('claims').select('id').eq('id', claim_id).single();
    if (cErr || !claim) throw new Error(`Claim not found: ${claim_id}`);
    rule = _resolveRule(finalCategory, doc.key_fields?.signals);
  } else if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required — rejected documents are documented, never dropped');
  }

  // Atomic claim: pending → resolving. Loser of a race gets the same
  // "not pending" error a stale read would.
  const now = new Date().toISOString();
  const { data: claimed, error: clErr } = await supabase.from('claim_documents')
    .update({ triage_status: 'resolving', updated_at: now })
    .eq('id', docId).eq('triage_status', 'pending')
    .select();
  if (clErr) throw new Error(`resolveTriage: claim failed — ${clErr.message}`);
  if (!claimed || claimed.length === 0) throw new Error('Document is not pending triage');

  const _audit = async (auditAction, description, newValue) => {
    const { error } = await supabase.from('audit_log').insert({
      action: auditAction, resource_type: 'claim_document', resource_id: docId,
      description, new_value: newValue || null, actor: actorEmail || null, created_at: now,
    });
    if (error) throw new Error(`audit insert failed: ${error.message}`);
  };

  try {
    if (action === 'reject') {
      const { error: upErr } = await supabase.from('claim_documents')
        .update({
          status: 'rejected',
          rejection_reason: reason, resolved_by: actorEmail || null, resolved_at: now,
          updated_at: now,
        })
        .eq('id', docId);
      if (upErr) throw new Error(`reject update failed: ${upErr.message}`);
      await _audit('document_rejected',
        `Triage rejection: "${doc.title}" — ${reason}`,
        { reason, triage_reason: doc.triage_reason });
      const { data: updated, error: finErr } = await supabase.from('claim_documents')
        .update({ triage_status: 'resolved', updated_at: new Date().toISOString() })
        .eq('id', docId).eq('triage_status', 'resolving')
        .select().single();
      if (finErr || !updated) throw new Error(`finalize failed: ${finErr ? finErr.message : 'claim was lost'}`);
      return { document: updated, diary: null };
    }

    // triage_status stays 'resolving' until the WHOLE unit commits, so
    // a failure can always revert on that guard.
    const { error: upErr } = await supabase.from('claim_documents')
      .update({
        claim_id, category: finalCategory, status: 'filed',
        relevant_to: [rule.diary_type],
        resolved_by: actorEmail || null, resolved_at: now,
        updated_at: now,
      })
      .eq('id', docId);
    if (upErr) throw new Error(`file update failed: ${upErr.message}`);

    let diary;
    try {
      // Deadlines still anchor to the original channel receipt — triage
      // latency never extends a statutory clock.
      diary = await _createDiary(claim_id, rule, docId, doc.received_at);
      await _writeEvent(claim_id, 'document_ingested', {
        document_id: docId, category: finalCategory, via: 'human_triage',
        received_at: doc.received_at, actor: actorEmail || null,
      });
      await _audit('document_triage_filed',
        `Triage filed: "${doc.title}" → ${claim_id} (${finalCategory})`,
        { claim_id, category: finalCategory, diary_type: rule.diary_type });
    } catch (e) {
      if (diary) await supabase.from('diaries').delete().eq('id', diary.id);
      throw e;
    }

    const { data: updated, error: finErr } = await supabase.from('claim_documents')
      .update({ triage_status: 'resolved', updated_at: new Date().toISOString() })
      .eq('id', docId).eq('triage_status', 'resolving')
      .select().single();
    if (finErr || !updated) {
      if (diary) await supabase.from('diaries').delete().eq('id', diary.id);
      throw new Error(`finalize failed: ${finErr ? finErr.message : 'claim was lost'}`);
    }

    return { document: updated, diary };
  } catch (e) {
    // Revert the claim so the document is not stranded in 'resolving'.
    await supabase.from('claim_documents')
      .update({
        triage_status: 'pending', status: 'triage',
        claim_id: doc.claim_id, category: doc.category,
        rejection_reason: null, resolved_by: null, resolved_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId).eq('triage_status', 'resolving');
    throw e;
  }
}

module.exports = {
  ingestDocument,
  ingestPdf,
  extractPdfText,
  listTriage,
  resolveTriage,
  CONFIDENCE_THRESHOLD,
  PDF_MIN_TEXT_CHARS,
  PDF_MAX_BYTES,
  DOC_ACTION_RULES,
  SIGNAL_OVERRIDES,
};
