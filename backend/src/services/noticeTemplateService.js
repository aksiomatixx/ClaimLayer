'use strict';

/**
 * Notice Generation Library (Tier 1).
 *
 * Twenty-template registry covering the §9810-family worker notices and
 * the §9785/§9792.9 provider notices, with a uniform generation path:
 *
 *   generateNotice(type, claimId, ctx)
 *     → renders a PDF (pdf-lib), files it as a claim_documents row,
 *     → inserts benefit_notices tracking rows (worker/provider + an
 *       attorney copy whenever the worker is represented),
 *     → computes the delivery due date from the template's deadline basis.
 *
 * REGULATORY HONESTY — read before editing:
 *   Template body text below is DRAFT. The authoritative notice language
 *   lives in 8 CCR §§9810–9815, 9792.9, 9767.12, and 9785, which are NOT
 *   yet committed to docs/regulatory/. Every rendered PDF carries a DRAFT
 *   banner until those sources land and the text is verified against
 *   them (deferred task: "acquire 8 CCR notice sources"). Spanish
 *   versions are required by §9812(g) but are NEVER synthesized here —
 *   requesting 'es' produces a 'blocked_pending_translation' tracking row
 *   and a loud warning, mirroring the WCIS stub-CSV pattern.
 *
 * The five M9 bespoke generators (DWC-7, TD notice, RFA letter, IMR
 * rights, denial) remain the production path for their flows; their
 * registry entries point at them via `bespoke`. Consolidation of the M9
 * `notices` table into benefit_notices is a recorded cleanup task.
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { supabase }  = require('./supabase');
const config        = require('../config');
const logger        = require('../logger');
const { addBusinessDays } = require('../utils/businessDays');

const DRAFT_BANNER =
  'DRAFT TEMPLATE — body text pending verification against authoritative 8 CCR sources (docs/regulatory/). Not for production mailing.';

function _cal(days) {
  return (fromDate) => {
    const d = new Date((fromDate || new Date().toISOString().split('T')[0]) + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };
}
function _biz(days) {
  return (fromDate) => {
    const d = addBusinessDays(fromDate || new Date().toISOString().split('T')[0], days);
    return typeof d === 'string' ? d : d.toISOString().split('T')[0];
  };
}

// ── The registry ──────────────────────────────────────────────────────────────
// audience: 'worker' | 'provider'. Worker-facing notices automatically get
// an attorney copy when the claim is represented (§9810(f) practice).
// cites reference the governing sections recorded in the master context;
// they locate the rule, they do not reproduce its text.
const NOTICE_TEMPLATES = {
  claim_accepted: {
    audience: 'worker', cite: '8 CCR §9812(a)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Claim Acceptance — Initial Notice of Benefits',
    body: (c) => [
      `Your workers' compensation claim ${c.claimNumber || ''} for the injury of ${c.dateOfInjury || ''} has been ACCEPTED.`,
      'You are entitled to medical care for your injury and, if you lose time from work, disability benefits as provided by law.',
      'A summary of the benefits that may apply to your claim is enclosed.',
    ],
  },
  claim_denied: {
    audience: 'worker', cite: '8 CCR §9812(g)(1)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    bespoke: 'noticeService.generateDenialNotice',
    title: 'Notice of Claim Denial',
    body: (c) => [
      `After investigation, your claim ${c.claimNumber || ''} has been DENIED.`,
      'You have the right to disagree with this decision and to a hearing before the Workers\' Compensation Appeals Board.',
      'Free information and assistance is available from the DWC Information & Assistance Unit at 1-800-736-7401.',
    ],
  },
  td_commencement: {
    audience: 'worker', cite: '8 CCR §9812(a)(1)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    bespoke: 'noticeService.generateTdNotice',
    title: 'Notice of Temporary Disability Benefits — First Payment',
    body: (c, x) => [
      `Temporary disability benefits are beginning on your claim ${c.claimNumber || ''}.`,
      `Your benefit rate is $${x.weekly_rate || c.tdRate || ''} per week, two-thirds of your average weekly wage, paid every 14 days.`,
    ],
  },
  td_rate_change: {
    audience: 'worker', cite: '8 CCR §9812(b)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Change in Temporary Disability Rate',
    body: (c, x) => [
      `The weekly rate of your temporary disability benefits has changed to $${x.weekly_rate || ''} effective ${x.effective_date || ''}.`,
      'The basis for this change is described below.',
    ],
  },
  td_suspension: {
    audience: 'worker', cite: '8 CCR §9812(c)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Suspension of Temporary Disability Benefits',
    body: (c, x) => [
      `Your temporary disability benefits are suspended effective ${x.effective_date || ''}.`,
      `Reason: ${x.reason || 'see enclosed explanation'}.`,
      'If you disagree, you may request a hearing before the Workers\' Compensation Appeals Board.',
    ],
  },
  td_reinstatement: {
    audience: 'worker', cite: '8 CCR §9812(b)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Reinstatement of Temporary Disability Benefits',
    body: (c, x) => [
      `Your temporary disability benefits are reinstated effective ${x.effective_date || ''} at $${x.weekly_rate || ''} per week.`,
    ],
  },
  td_termination: {
    audience: 'worker', cite: '8 CCR §9812(d)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Termination of Temporary Disability Benefits',
    body: (c, x) => [
      `Your temporary disability benefits end effective ${x.end_date || ''}.`,
      `Reason: ${x.reason || 'see enclosed explanation'}.`,
      'Any permanent disability benefits you may be owed are addressed separately.',
    ],
  },
  pd_commencement: {
    audience: 'worker', cite: '8 CCR §9812(e)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Permanent Disability Benefits — First Payment',
    body: (c, x) => [
      `Permanent disability benefits are beginning on your claim ${c.claimNumber || ''} at $${x.weekly_rate || ''} per week.`,
      'These advances are paid against your final permanent disability award (Labor Code §4650(b)).',
    ],
  },
  pd_rate_change: {
    audience: 'worker', cite: '8 CCR §9812(e)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Change in Permanent Disability Rate',
    body: (c, x) => [`Your permanent disability rate has changed to $${x.weekly_rate || ''} effective ${x.effective_date || ''}.`],
  },
  pd_suspension: {
    audience: 'worker', cite: '8 CCR §9812(e)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Suspension of Permanent Disability Benefits',
    body: (c, x) => [`Your permanent disability advances are suspended effective ${x.effective_date || ''}. Reason: ${x.reason || 'see enclosed'}.`],
  },
  pd_resumption: {
    audience: 'worker', cite: '8 CCR §9812(e)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice of Resumption of Permanent Disability Benefits',
    body: (c, x) => [`Your permanent disability advances resume effective ${x.effective_date || ''} at $${x.weekly_rate || ''} per week.`],
  },
  ps_mmi_rating: {
    audience: 'worker', cite: '8 CCR §9812(f)', deadline: { basis: 'calendar_days_14', compute: _cal(14) },
    title: 'Notice — Permanent and Stationary Status and Disability Rating',
    body: (c, x) => [
      'Your treating physician has found your condition permanent and stationary (maximal medical improvement).',
      `The medical report supports a permanent disability rating of ${x.pd_percent != null ? x.pd_percent + '%' : '(rating pending)'}; the rating explanation is enclosed.`,
      'You have the right to disagree with the rating and to the QME process described in the enclosed materials.',
    ],
  },
  settlement_offer: {
    audience: 'worker', cite: 'LC §5001; 8 CCR §10700', deadline: null,
    title: 'Settlement Offer Transmittal',
    body: (c, x) => [
      `Enclosed is a proposed ${x.settlement_type || 'settlement'} of your claim ${c.claimNumber || ''} in the amount of $${x.amount || ''}.`,
      'Any settlement requires approval by a workers\' compensation judge before it takes effect.',
    ],
  },
  ur_decision: {
    audience: 'worker', cite: '8 CCR §9792.9.1(e)', deadline: { basis: 'business_days_2', compute: _biz(2) },
    bespoke: 'noticeService.generateRfaLetter',
    title: 'Utilization Review Decision',
    body: (c, x) => [
      `A utilization review decision has been made on the treatment request of ${x.rfa_date || ''}: ${x.decision || ''}.`,
      'If treatment was modified or denied, the enclosed materials explain your Independent Medical Review rights.',
    ],
  },
  qme_process: {
    audience: 'worker', cite: '8 CCR §9813', deadline: { basis: 'calendar_days_10', compute: _cal(10) },
    title: 'Notice — Qualified Medical Evaluator Process',
    body: () => [
      'There is a dispute about a medical determination on your claim. You have the right to an evaluation by a Qualified Medical Evaluator (QME).',
      'The enclosed materials explain how a QME panel is requested and how an evaluator is selected.',
    ],
  },
  mpn_enrollment: {
    audience: 'worker', cite: '8 CCR §9767.12', deadline: null,
    title: 'Medical Provider Network — Notice of Coverage',
    body: () => [
      'Your medical care for this injury is provided through a Medical Provider Network (MPN).',
      'The enclosed materials describe how to choose and change physicians within the network, second and third opinion rights, and independent medical review.',
    ],
  },

  // ── Provider-facing ─────────────────────────────────────────────────────────
  ptp_authorization: {
    audience: 'provider', cite: '8 CCR §9785', deadline: null,
    title: 'Primary Treating Physician — Authorization and Billing Instructions',
    body: (c) => [
      `You are recognized as the primary treating physician for claim ${c.claimNumber || ''} (DOI ${c.dateOfInjury || ''}). The claim is accepted for the body parts listed.`,
      'Reporting duties under 8 CCR §9785 apply, including PR-2 progress reports. Billing instructions are enclosed.',
    ],
  },
  ptp_change: {
    audience: 'provider', cite: '8 CCR §9785(b)', deadline: null,
    title: 'Notice of Change of Primary Treating Physician',
    body: (c, x) => [`Effective ${x.effective_date || ''}, the primary treating physician for claim ${c.claimNumber || ''} has changed. Your reporting role on this claim has ended.`],
  },
  specialist_authorization: {
    audience: 'provider', cite: '8 CCR §9785', deadline: null,
    title: 'Specialist Consultation Authorization',
    body: (c, x) => [`A specialist consultation (${x.specialty || ''}) is authorized for claim ${c.claimNumber || ''}. Authorization scope and billing instructions are enclosed.`],
  },
  ur_decision_provider: {
    audience: 'provider', cite: '8 CCR §9792.9.1', deadline: { basis: 'business_days_2', compute: _biz(2) },
    title: 'Utilization Review Decision — Requesting Physician Copy',
    body: (c, x) => [
      `Utilization review decision for your treatment request of ${x.rfa_date || ''} on claim ${c.claimNumber || ''}: ${x.decision || ''}.`,
      'Peer-to-peer discussion and appeal rights are described in the enclosed decision.',
    ],
  },
};

// ── PDF rendering ─────────────────────────────────────────────────────────────

async function _renderNoticePdf(template, claim, ctx, language) {
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
          page.drawText(cur, { x: 50, y, size, font: f, color }); y -= size + 6; cur = w;
        } else cur = probe;
      }
      if (cur) { page.drawText(cur, { x: 50, y, size, font: f, color }); y -= size + 6; }
    }
  };

  line(DRAFT_BANNER, bold, 8.5, red); y -= 8;
  line('ClaimLayer — Workers\' Compensation Administration', bold, 11, gray); y -= 10;
  line(template.title, bold, 15, dark); y -= 4;
  line(`Authority: ${template.cite}   ·   Claim ${claim.claimNumber || claim.id}   ·   ${new Date().toISOString().split('T')[0]}`, font, 9, gray);
  y -= 16;
  for (const para of template.body(claim, ctx || {})) {
    line(para, font, 11.5, dark); y -= 8;
  }
  y -= 14;
  line(`Questions: ${config.adjuster.name}, ${config.adjuster.phone}, ${config.adjuster.email}`, font, 9.5, gray);
  if (language !== 'es') {
    y -= 10;
    line('Free information and assistance: DWC Information & Assistance Unit, 1-800-736-7401.', font, 9.5, gray);
  }
  return Buffer.from(await pdf.save());
}

// ── Generation ────────────────────────────────────────────────────────────────

function _nid() { return `bn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

/**
 * Generate a notice: PDF → claim_documents, tracking rows → benefit_notices.
 * Returns { notices: [rows], document } — multiple rows when an attorney
 * copy is added or a Spanish row is blocked pending translation.
 */
async function generateNotice(noticeType, claimId, ctx = {}, opts = {}) {
  const template = NOTICE_TEMPLATES[noticeType];
  if (!template) {
    throw new Error(`Unknown notice type: ${noticeType}. Valid: ${Object.keys(NOTICE_TEMPLATES).join(', ')}`);
  }

  const claimService = require('./claimService');
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const { data: rawClaim } = await supabase.from('claims').select('*').eq('id', claimId).single();
  const { isRepresented } = require('../utils/representation');
  const represented = isRepresented(rawClaim) || isRepresented(claim);

  const now = new Date().toISOString();
  const eventDate = ctx.event_date || now.split('T')[0];
  const dueDate = template.deadline ? template.deadline.compute(eventDate) : null;

  // Render + file the English PDF as a claim document.
  const pdfBuffer = await _renderNoticePdf(template, claim, ctx, 'en');
  const docRow = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    claim_id: claimId,
    title: template.title,
    category: 'correspondence',
    source: 'system_generated',
    received_at: now,
    pages: 1,
    status: 'filed',
    ai_summary: null,
    relevant_to: [],
    content_text: null,
    pdf_buffer_b64: pdfBuffer.toString('base64'),
    classification_confidence: null,
    triage_status: 'none',
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const { data: document, error: docErr } = await supabase
    .from('claim_documents').insert(docRow).select().single();
  if (docErr) throw new Error(`noticeTemplateService: document insert failed — ${docErr.message}`);

  const emp = claim.employee || {};
  const workerName = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Injured Worker';

  const rows = [];
  const baseRow = {
    claim_id: claimId,
    notice_type: noticeType,
    regulatory_cite: template.cite,
    deadline_basis: template.deadline ? template.deadline.basis : null,
    due_date: dueDate,
    document_id: document.id,
    status: 'generated',
    method: null,
    delivery_attempts: 0,
    created_at: now,
    updated_at: now,
  };

  if (template.audience === 'worker') {
    rows.push({ ...baseRow, id: _nid(), audience: 'worker', language: 'en',
      recipient: { name: workerName, address: emp.address || null } });

    // §9812(g): Spanish version required for worker-facing notices. We do
    // NOT synthesize translations — the row is created blocked, mirroring
    // the WCIS stub-CSV PENDING pattern, and unblocks when authoritative
    // Spanish templates land in docs/regulatory/.
    if (opts.language === 'es' || opts.includeSpanish) {
      logger.warn({
        warning: 'NOTICE_TRANSLATION_PENDING',
        msg: 'Spanish notice required (§9812(g)) but no authoritative translation is committed — tracking row created blocked',
        noticeType, claimId,
      });
      rows.push({ ...baseRow, id: _nid(), audience: 'worker', language: 'es',
        document_id: null, status: 'blocked_pending_translation',
        recipient: { name: workerName, address: emp.address || null } });
    }

    if (represented) {
      rows.push({ ...baseRow, id: _nid(), audience: 'attorney', language: 'en',
        recipient: {
          name: rawClaim?.attorney_name || 'Attorney of record',
          firm: rawClaim?.attorney_firm || null,
          email: rawClaim?.attorney_email || null,
        } });
    }
  } else {
    rows.push({ ...baseRow, id: _nid(), audience: 'provider', language: 'en',
      recipient: ctx.provider || { name: ctx.provider_name || 'Treating provider' } });
  }

  for (const row of rows) {
    const { error } = await supabase.from('benefit_notices').insert(row);
    if (error) throw new Error(`noticeTemplateService: tracking insert failed — ${error.message}`);
  }

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'notice_generated', timestamp: now,
    data: { notice_type: noticeType, recipients: rows.map(r => r.audience), due_date: dueDate },
  });

  return { notices: rows, document };
}

async function listNotices(claimId) {
  const { data, error } = await supabase
    .from('benefit_notices').select('*').eq('claim_id', claimId);
  if (error) throw new Error(`noticeTemplateService.listNotices: ${error.message}`);
  return (data || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

module.exports = {
  NOTICE_TEMPLATES,
  generateNotice,
  listNotices,
  DRAFT_BANNER,
};
