'use strict';

/**
 * Settlement Form Generation (Tier 1).
 *
 * Assembles DWC-WCAB settlement packages from claim data:
 *   - 10214(c) Compromise & Release  — generateCnRPackage(claimId)
 *   - 10214(a) Stipulations w/ Award — generateStipPackage(claimId)
 *
 * REGULATORY HONESTY — the official DWC AcroForm templates
 * (dwc_ca_form_10214a/c rev 2020-05) are NOT committed to
 * docs/regulatory/. Until they land, this service renders a
 * DRAFT-watermarked field rendition: the same field DATA the official
 * form requires, laid out for review, explicitly not the official form.
 * Swapping the renderer to AcroForm fill (pdf-lib getForm()) when the
 * templates arrive changes only _render*, not the assembly logic.
 *
 * GUARDRAILS (code, not prompts):
 *   - A C&R package will NOT generate without a completed MSA screen,
 *     and never when the screen says an MSA is required but the offer
 *     carries none — the M19 deterministic gate, enforced again at the
 *     document boundary.
 *   - Settlement sums come from the settlement_offers row (with the
 *     M22A C&R breakdown columns when present, sum-validated). Nothing
 *     in this service invents a number.
 *
 * Versioning: regenerating a package supersedes the prior version in
 * claim_documents (version n+1, prior marked 'superseded').
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');
const { isRepresented } = require('../utils/representation');

const DRAFT_WATERMARK =
  'DRAFT FIELD RENDITION — NOT THE OFFICIAL DWC FORM. Official 10214 AcroForm templates pending in docs/regulatory/.';

// ── Standard-language library ────────────────────────────────────────────────
// Freeform blocks the forms require. DRAFT until verified against committed
// WCAB-approved language; each entry carries its draft flag explicitly.
const STANDARD_LANGUAGE = {
  cnr_release_scope: {
    draft: true,
    text: 'The parties settle all claims arising out of the injury(ies) described herein, including all claims for temporary disability, permanent disability, and medical treatment, except as expressly excluded below.',
  },
  cnr_dispute_future_medical: {
    draft: true,
    text: 'The parties dispute the nature and extent of the need for future medical treatment; this Compromise and Release resolves that dispute by buyout.',
  },
  cnr_dispute_earnings: {
    draft: true,
    text: 'The parties dispute the applicable earnings basis and the resulting indemnity rates; this settlement compromises that dispute.',
  },
  cnr_dispute_body_parts: {
    draft: true,
    text: 'The parties dispute whether all claimed body parts arise out of and in the course of employment; this settlement compromises that dispute.',
  },
  stip_future_medical_open: {
    draft: true,
    text: 'Defendant shall provide further medical treatment reasonably required to cure or relieve from the effects of the injury, per the award.',
  },
};

// ── Data assembly ─────────────────────────────────────────────────────────────

async function _latestOffer(claimId) {
  const { data } = await supabase
    .from('settlement_offers').select('*').eq('claim_id', claimId);
  const rows = (data || []).sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)));
  return rows[0] || null;
}

async function _latestMsa(claimId) {
  const { data } = await supabase
    .from('msa_screenings').select('*').eq('claim_id', claimId);
  const rows = (data || []).sort((a, b) =>
    String(b.screened_at || b.created_at || '').localeCompare(String(a.screened_at || a.created_at || '')));
  return rows[0] || null;
}

async function _latestStip(claimId) {
  const { data } = await supabase
    .from('stipulations').select('*').eq('claim_id', claimId);
  const rows = (data || []).sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)));
  return rows[0] || null;
}

function _breakdown(offer) {
  const parts = {
    pd:       offer.cnr_pd_amount,
    medical:  offer.cnr_medical_amount,
    attorney: offer.cnr_attorney_fee_amount,
    other:    offer.cnr_other_amount,
  };
  const present = Object.values(parts).every(v => v != null);
  if (!present) return { available: false, parts: null, sumMatches: null };
  const sum = Object.values(parts).reduce((a, b) => a + Number(b), 0);
  const sumMatches = Math.abs(sum - Number(offer.cnr_value)) < 0.01;
  return { available: true, parts, sumMatches, source: offer.cnr_breakdown_source || 'estimate' };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

async function _renderPackage(formName, claim, sections) {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.42, 0.42, 0.42);
  const red  = rgb(0.72, 0.12, 0.12);
  let y = 744;
  const line = (text, f, size, color) => {
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const w of para.split(' ')) {
        const probe = cur ? cur + ' ' + w : w;
        if (f.widthOfTextAtSize(probe, size) > 512) {
          page.drawText(cur, { x: 50, y, size, font: f, color }); y -= size + 5; cur = w;
        } else cur = probe;
      }
      if (cur) { page.drawText(cur, { x: 50, y, size, font: f, color }); y -= size + 5; }
    }
  };

  line(DRAFT_WATERMARK, bold, 8.5, red); y -= 8;
  line(formName, bold, 15, dark); y -= 2;
  const emp = claim.employee || {};
  line(`Claim ${claim.claimNumber || claim.id} · ${[emp.firstName, emp.lastName].filter(Boolean).join(' ')} · DOI ${claim.dateOfInjury || ''}`, font, 9.5, gray);
  y -= 14;
  for (const [heading, rows] of sections) {
    line(heading.toUpperCase(), bold, 10.5, dark); y -= 2;
    for (const r of rows) line(r, font, 10.5, dark);
    y -= 10;
  }
  line(`Prepared by ${config.adjuster.name} · ${config.adjuster.email} · ${new Date().toISOString().split('T')[0]}`, font, 8.5, gray);
  return Buffer.from(await pdf.save());
}

async function _fileVersioned(claimId, title, pdfBuffer, kind) {
  const now = new Date().toISOString();
  // supersede prior versions of the same package kind
  const { data: priors } = await supabase
    .from('claim_documents').select('*').eq('claim_id', claimId);
  const sameKind = (priors || []).filter(d => d.package_kind === kind && d.status === 'filed');
  for (const p of sameKind) {
    await supabase.from('claim_documents')
      .update({ status: 'superseded', updated_at: now }).eq('id', p.id);
  }
  const version = sameKind.reduce((m, p) => Math.max(m, p.version || 1), 0) + 1;

  const row = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    claim_id: claimId,
    title: `${title} (v${version})`,
    category: 'settlement',
    source: 'system_generated',
    package_kind: kind,
    received_at: now,
    pages: 1,
    status: 'filed',
    ai_summary: null,
    relevant_to: [],
    pdf_buffer_b64: pdfBuffer.toString('base64'),
    triage_status: 'none',
    version,
    created_at: now,
    updated_at: now,
  };
  const { data: document, error } = await supabase
    .from('claim_documents').insert(row).select().single();
  if (error) throw new Error(`settlementDocumentService: file failed — ${error.message}`);
  return document;
}

const fmt$ = (n) => n != null ? `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—';

// ── C&R 10214(c) ─────────────────────────────────────────────────────────────

async function generateCnRPackage(claimId, opts = {}) {
  const claimService = require('./claimService');
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const offer = await _latestOffer(claimId);
  if (!offer) throw new Error('No settlement offer on file — price the C&R before generating the package');
  if (offer.cnr_value == null) throw new Error('Offer has no C&R value');

  // M19 deterministic gate, re-enforced at the document boundary.
  const msa = await _latestMsa(claimId);
  if (!msa) {
    throw new Error('CNR_PACKAGE_BLOCKED_NO_MSA_SCREEN — run the Medicare-interest screen first');
  }
  if (msa.msa_required && !opts.msa_included) {
    throw new Error('CNR_PACKAGE_BLOCKED_MSA_REQUIRED — the screen requires an MSA; include it before generating');
  }

  const { data: rawClaim } = await supabase.from('claims').select('*').eq('id', claimId).single();
  const represented = isRepresented(rawClaim) || isRepresented(claim);
  const bd = _breakdown(offer);

  const disputes = (opts.disputes || ['future_medical'])
    .map(d => STANDARD_LANGUAGE[`cnr_dispute_${d}`])
    .filter(Boolean);

  const sections = [
    ['Parties', [
      `Applicant: ${[claim.employee?.firstName, claim.employee?.lastName].filter(Boolean).join(' ')}`,
      `Employer: ${claim.employerName || claim.employerId || ''}`,
      represented
        ? `Applicant's attorney: ${rawClaim?.attorney_name || '(of record)'} ${rawClaim?.attorney_firm ? `— ${rawClaim.attorney_firm}` : ''}`
        : 'Applicant is unrepresented — DWC I&A disclosure required at signing',
    ]],
    ['Settlement amount', [
      `Total Compromise & Release amount: ${fmt$(offer.cnr_value)}`,
      ...(bd.available ? [
        `  Permanent disability: ${fmt$(bd.parts.pd)}`,
        `  Future medical buyout: ${fmt$(bd.parts.medical)}`,
        `  Attorney fee: ${fmt$(bd.parts.attorney)}`,
        `  Other: ${fmt$(bd.parts.other)}`,
        `  Breakdown source: ${bd.source}${bd.sumMatches ? '' : '  !! BREAKDOWN DOES NOT SUM TO TOTAL — resolve before filing'}`,
      ] : ['  Breakdown: single-line (DN85 500 fallback) — itemize at OACR']),
    ]],
    ['Medicare interests (deterministic screen)', [
      `MSA screen ${msa.id}: msa_required=${!!msa.msa_required}${msa.msa_required ? ' — MSA included per adjuster confirmation' : ' — no Medicare interest identified'}`,
    ]],
    ['Release', [STANDARD_LANGUAGE.cnr_release_scope.text]],
    ['Disputed issues resolved by this compromise', disputes.map(d => `• ${d.text}`)],
    ['Signatures', [
      'Worker signature: ____________________  Date: ________',
      ...(represented ? ['Applicant attorney: ____________________  Date: ________'] : []),
      'Claims administrator: ____________________  Date: ________',
      'WCAB approval (Order Approving C&R) required before any payment issues.',
    ]],
  ];

  const pdfBuffer = await _renderPackage('Compromise and Release — DWC-CA 10214(c) [DRAFT RENDITION]', claim, sections);
  const document = await _fileVersioned(claimId, 'Compromise & Release package', pdfBuffer, 'cnr_10214c');

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'settlement_package_generated',
    timestamp: new Date().toISOString(),
    data: { kind: 'cnr_10214c', document_id: document.id, version: document.version, offer_id: offer.id },
  });

  return {
    document,
    draft: true,
    offer_id: offer.id,
    msa_screening_id: msa.id,
    breakdown: bd,
    represented,
  };
}

// ── Stipulations 10214(a) ────────────────────────────────────────────────────

async function generateStipPackage(claimId) {
  const claimService = require('./claimService');
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const stip = await _latestStip(claimId);
  if (!stip) throw new Error('No stipulation on file — create the stipulation before generating the package');

  const { data: rawClaim } = await supabase.from('claims').select('*').eq('id', claimId).single();
  const represented = isRepresented(rawClaim) || isRepresented(claim);

  const sections = [
    ['Parties', [
      `Applicant: ${[claim.employee?.firstName, claim.employee?.lastName].filter(Boolean).join(' ')}`,
      `Employer: ${claim.employerName || claim.employerId || ''}`,
      represented
        ? `Applicant's attorney: ${rawClaim?.attorney_name || '(of record)'}`
        : 'Applicant is unrepresented — DWC I&A disclosure required at signing',
    ]],
    ['Stipulated award', [
      `Permanent disability: ${stip.pd_percent}%  ·  Total: ${fmt$(stip.pd_total_value)}`,
      `Body parts: ${(stip.body_parts_accepted || []).join(', ') || claim.bodyPart || ''}`,
      stip.future_medical
        ? `Future medical: OPEN — ${STANDARD_LANGUAGE.stip_future_medical_open.text}`
        : 'Future medical: not provided under this award',
      ...(stip.future_medical_desc ? [`Scope: ${stip.future_medical_desc}`] : []),
    ]],
    ['Statute of limitations', [
      'Petition to reopen: five years from date of injury (LC §5410); LC §5405 limitations noted.',
    ]],
    ['Signatures', [
      'Worker signature: ____________________  Date: ________',
      ...(represented ? ['Applicant attorney: ____________________  Date: ________'] : []),
      'Claims administrator: ____________________  Date: ________',
      'EAMS filing is manual: the package is prepared by the system, filed by the adjuster.',
    ]],
  ];

  const pdfBuffer = await _renderPackage('Stipulations with Request for Award — DWC-CA 10214(a) [DRAFT RENDITION]', claim, sections);
  const document = await _fileVersioned(claimId, 'Stipulations with Request for Award package', pdfBuffer, 'stip_10214a');

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'settlement_package_generated',
    timestamp: new Date().toISOString(),
    data: { kind: 'stip_10214a', document_id: document.id, version: document.version, stipulation_id: stip.id },
  });

  return { document, draft: true, stipulation_id: stip.id, represented };
}

module.exports = {
  generateCnRPackage,
  generateStipPackage,
  STANDARD_LANGUAGE,
  DRAFT_WATERMARK,
};
