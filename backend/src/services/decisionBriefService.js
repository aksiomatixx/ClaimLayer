'use strict';

/**
 * Decision Brief — plain-language "what you need to do and why" for the
 * adjuster, composed deterministically from the claim file (status, open
 * diaries, AI analysis, documents). No model call: the brief must be
 * explainable line-by-line from claim data, so it is templated, not
 * generated.
 *
 * Returns:
 *   {
 *     summary:  string                 — where the claim stands, in plain language
 *     contract: string                 — the operating promise for the queue
 *     actions: [{
 *       action, why, due_date, priority, diary_id, document_ids
 *     }]
 *   }
 */

const { isRepresented } = require('../utils/representation');

// Plain-language playbook per diary type. `action` says what to do;
// `why(ctx)` says what in the claim led to it.
const PLAYBOOK = {
  DWC1_ISSUE: {
    action: 'Issue the DWC-1 claim form to the worker',
    why: c => `A new claim was reported on ${c.doi}. California requires the claim form to go out within one working day of notice (LC §5401).`,
  },
  DWC7_NOTICE: {
    action: 'Mail the DWC-7 notice of rights',
    why: () => 'Every new claim triggers the notice-of-potential-eligibility requirement — it must be mailed with the claim form.',
  },
  AI_ANALYSIS_PENDING: {
    action: 'Run the AI compensability analysis',
    why: () => 'Intake is complete. The compensability agent will draft the analysis, suggested reserves, and red flags for your review.',
  },
  COMPENSABILITY_DECISION_DUE: {
    action: 'Decide compensability — accept, delay, or deny',
    why: c => `The 90-day decision window under LC §5402 is running${c.ai ? `. The AI assessment is "${c.ai.compensability}" at ${c.ai.compensabilityScore}% confidence — the call is yours` : ''}.`,
  },
  TD_PAYMENT_REVIEW: {
    action: 'Review the temporary disability payment',
    why: c => `An active TD benefit is paying${c.tdRate ? ` at $${c.tdRate}/wk (two-thirds of AWW)` : ''}. Confirm work status before the next payment cycle to avoid an LC §4650 self-imposed penalty.`,
  },
  PD_ADVANCE_DUE: {
    action: 'Start permanent disability advances',
    why: c => `The claim is rated for permanent disability${c.represented ? ' and the worker is represented, so advances are capped at 85% pending the C&R' : ''}. PD is owed within 14 days of TD ending (LC §4650(b)).`,
  },
  CNR_OFFER_FOLLOWUP: {
    action: 'Follow up on the C&R settlement offer',
    why: c => `A Compromise & Release offer is outstanding${c.represented ? " — the worker is represented, so all contact goes through the attorney" : ''}. The pricing agent's valuation and the MSA screen are on file.`,
  },
  CNR_ADJUSTER_SIGN: {
    action: 'Sign the C&R settlement documents',
    why: () => 'The worker has signed. Your signature releases the settlement to EAMS filing and disbursement.',
  },
  CNR_PAYMENT_DUE: {
    action: 'Issue the settlement payment',
    why: () => 'The Order Approving C&R is in. Payment is due within 30 days or LC §5814 penalties attach.',
  },
  RFA_INTAKE_REVIEW: {
    action: 'Route the received RFA to MTUS evaluation',
    why: () => 'A Request for Authorization arrived — the UR clock under 8 CCR §9792.9.1 started at receipt. The MTUS agent can only recommend auto-approve or physician review; denial is yours alone.',
  },
  MED_REPORT_REVIEW: {
    action: 'Review the new medical report',
    why: () => 'A medical report was ingested, summarized, and filed by the document agent. Confirm the findings and treatment plan are reflected in the claim posture.',
  },
  PR4_RECEIVED_REVIEW: {
    action: 'Review the P&S report and start the rating pathway',
    why: () => 'The ingested report indicates the worker is permanent and stationary — PR-4 review drives the PD evaluation and rating.',
  },
  REPRESENTATION_REVIEW: {
    action: 'Verify the representation change',
    why: () => 'An ingested legal document indicates a representation change. Confirm and record it via the representation workflow — SROI 02 fires automatically when the state changes.',
  },
  SETTLEMENT_DOC_REVIEW: {
    action: 'Reconcile the settlement document',
    why: () => 'A settlement document was ingested — reconcile it against the open offer, the MSA screen, and the C&R breakdown.',
  },
  AWW_RECALC_REVIEW: {
    action: 'Verify AWW against the new wage documentation',
    why: c => `Wage documentation arrived. Confirm the average weekly wage${c.tdRate ? ` and the $${c.tdRate}/wk TD rate (two-thirds AWW)` : ''} still hold.`,
  },
  STIP_ATTORNEY_TRANSMIT: {
    action: 'Send the stipulation package to the worker’s attorney',
    why: () => 'The worker is represented — the stip must go to counsel for review and signature, never directly to the worker.',
  },
};

function _humanize(type) {
  return type.toLowerCase().replace(/_/g, ' ').replace(/^./, ch => ch.toUpperCase());
}

const STATUS_LANG = {
  new_claim:              'just reported and awaiting first contact',
  intake_complete:        'through intake and queued for analysis',
  under_investigation:    'under investigation inside the 90-day decision window',
  active_medical:         'accepted, with active medical treatment',
  p_and_s:                'permanent and stationary',
  pd_evaluation:          'in permanent disability evaluation',
  settlement_discussions: 'in settlement discussions',
  closed:                 'closed',
};

function buildBrief({ claim, diaries = [], documents = [] }) {
  const represented = isRepresented(claim) ||
    !!(claim.attorneyRepresented || claim.metadata?.attorney_represented);
  const ctx = {
    doi:        claim.dateOfInjury || claim.date_of_injury || 'the reported date',
    ai:         claim.aiAnalysis || null,
    tdRate:     claim.tdRate ?? claim.td_rate ?? null,
    represented,
  };

  const open = diaries
    .filter(d => (d.status || 'open') === 'open')
    .sort((a, b) => String(a.due_date || a.dueDate || '').localeCompare(String(b.due_date || b.dueDate || '')));

  const actions = open.map(d => {
    const type = d.diary_type || d.diaryType || d.type || '';
    const play = PLAYBOOK[type];
    const docIds = documents
      .filter(doc => {
        const rel = doc.relevant_to || [];
        return Array.isArray(rel) ? rel.includes(type) : rel === type;
      })
      .map(doc => doc.id);
    return {
      action:       play ? play.action : _humanize(type),
      why:          play ? play.why(ctx) : (d.notes || 'Queued by the statutory deadline engine.'),
      due_date:     d.due_date || d.dueDate || null,
      priority:     d.priority || 'MEDIUM',
      diary_id:     d.id || d.diaryId,
      document_ids: docIds,
    };
  });

  const standing = STATUS_LANG[claim.status] || `in status "${claim.status}"`;
  const emp = claim.employee || {};
  const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'The worker';
  const injury = [claim.injuryType, claim.bodyPart].filter(Boolean).join(' — ');

  const parts = [
    `${name}'s claim${injury ? ` (${injury})` : ''} is ${standing}.`,
  ];
  if (ctx.ai) {
    parts.push(`The compensability agent assessed it "${ctx.ai.compensability}" (${ctx.ai.compensabilityScore}%) with ${ctx.ai.priority || 'normal'} priority.`);
  }
  if (represented) parts.push('The worker is represented — all settlement contact goes through the attorney.');
  parts.push(actions.length
    ? `${actions.length} action${actions.length > 1 ? 's' : ''} ${actions.length > 1 ? 'are' : 'is'} queued below.`
    : 'Nothing is queued — the file is current.');

  return {
    summary:  parts.join(' '),
    contract: 'Work the queue and the statutory timelines are met — every deadline below was computed by the system, and completing an action documents it, sends the notices, and sets the next diaries automatically.',
    actions,
  };
}

module.exports = { buildBrief, PLAYBOOK };
