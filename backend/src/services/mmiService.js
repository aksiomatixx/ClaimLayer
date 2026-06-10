'use strict';

// ── M22A WCIS NOTE ────────────────────────────────────────────────
// mmiService intentionally has NO WCIS triggers. MMI / P&S is a
// medical determination, not a directly reportable benefit event.
// The P&S date drives downstream transitions that ARE reportable —
// specifically pdService.initiatePDAdvances which fires SROI CB
// (TD → PD benefit transition) or SROI RB (PD after prior
// suspension). See pdService WCIS hooks for the actual trigger
// wire-up. Do not add WCIS triggers here.
// ─────────────────────────────────────────────────────────────────

/**
 * mmiService.js — M12 MMI Management + PR-4 Solicitation.
 *
 * MMI = Maximum Medical Improvement = P&S (Permanent & Stationary) in CA WC.
 *
 * CRITICAL: This service detects signals and creates diaries/evaluations only.
 *           It NEVER auto-changes claim status. Status change to p_and_s is
 *           adjuster-only, manual.
 *
 * PR-4 solicitation letter generated via pdf-lib, sent via lobService.
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { supabase } = require('./supabase');
const lobService   = require('./lobService');
const config       = require('../config');
const logger       = require('../logger');

// ── Lazy requires to break circular deps ─────────────────────────────────────
function _getClaimService() { return require('./claimService'); }
function _getAiService()    { return require('./aiService'); }
function _getPdService()    { return require('./pdService'); }

// ── PDF constants (match noticeService) ──────────────────────────────────────
const DARK   = rgb(0.1, 0.1, 0.1);
const GRAY   = rgb(0.4, 0.4, 0.4);
const BLUE   = rgb(0.0, 0.27, 0.55);
const LINE   = rgb(0.75, 0.75, 0.75);
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;

function _drawLine(page, x1, y, x2, color = LINE) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color });
}

function _drawLetterhead(page, fonts) {
  let y = PAGE_H - MARGIN;
  page.drawText('HomeCare TPA', { x: MARGIN, y, size: 18, font: fonts.bold, color: BLUE });
  y -= 14;
  page.drawText('Workers\' Compensation Administration', { x: MARGIN, y, size: 9, font: fonts.regular, color: GRAY });
  y -= 9;
  page.drawText(
    `${config.adjuster.email}  |  ${config.adjuster.phone}`,
    { x: MARGIN, y, size: 8, font: fonts.regular, color: GRAY },
  );
  y -= 4;
  _drawLine(page, MARGIN, y, PAGE_W - MARGIN, BLUE);
  y -= 20;
  return y;
}

function _formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + (isoDate.includes('T') ? '' : 'T00:00:00'));
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

// ── Audit log ────────────────────────────────────────────────────────────────

async function _writeAuditLog(action, resourceType, resourceId, description, newValue) {
  try {
    await supabase.from('audit_log').insert({
      action,
      resource_type: resourceType,
      resource_id:   resourceId,
      description,
      new_value:     newValue,
      user_role:     'system',
      created_at:    new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'mmiService: audit_log write failed', err: err.message, action, resourceId });
  }
}

// ── Diary helper ─────────────────────────────────────────────────────────────

async function _createDiary(claimId, diaryType, dueDate, priority, notes) {
  const row = {
    claim_id:    claimId,
    diary_type:  diaryType,
    due_date:    dueDate,
    assigned_to: config.adjuster.email,
    priority,
    notes,
    status:      'open',
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  new Date().toISOString(),
  };
  await supabase.from('diaries').insert(row);
  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'diary_created',
    timestamp: new Date().toISOString(),
    data:      { diaryType, dueDate, priority },
  });
  return row;
}

async function _closeDiary(claimId, diaryType) {
  await supabase
    .from('diaries')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('claim_id', claimId)
    .eq('diary_type', diaryType)
    .eq('status', 'open');
}

// ── Calendar day math ────────────────────────────────────────────────────────

function _addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// MMI Signal AI Prompt
// ═════════════════════════════════════════════════════════════════════════════

const MMI_SYSTEM_PROMPT = `You are a California workers' compensation claims analyst evaluating whether a claim is approaching Maximum Medical Improvement (MMI), called Permanent & Stationary (P&S) in CA WC.

Evaluate the claim data for the following signals. Each signal has a weight:

1. claim_age_exceeds_typical (weight 1): Claim age exceeds typical recovery period for the injury type.
2. pr2_stable_plateau (weight 2): Most recent medical report language suggests stability — "stable," "plateau," "at baseline," "no further improvement expected."
3. treatment_frequency_declining (weight 1): Treatment/RFA frequency decreasing over time.
4. rfas_shifting_maintenance (weight 1): Recent RFAs are for maintenance-type treatment (massage, chiro maintenance, home exercise) rather than active treatment.
5. td_over_90_days_soft_tissue (weight 2): TD paid >90 days and injury is soft tissue only (strain, sprain, contusion).
6. td_104_week_approaching (weight 2): TD weeks paid >90 (approaching 104-week statutory cap).
7. no_active_treatment (weight 2): No RFAs in last 60 days, no upcoming appointments.

Return JSON:
{
  "signals": [
    { "type": "signal_name", "description": "one-sentence explanation", "weight": 1 or 2 }
  ],
  "recommendation": "no_action" | "monitor" | "solicit_pr4",
  "rationale": "One paragraph explaining your recommendation"
}

Rules:
- If 0 signals: recommendation = "no_action"
- If total weight 1-3: recommendation = "monitor"
- If total weight >= 4 OR any two weight-2 signals: recommendation = "solicit_pr4"
- You may ONLY detect signals from the list above. Do not invent new signal types.
- Never recommend changing claim status. That is an adjuster-only decision.`;

// ═════════════════════════════════════════════════════════════════════════════
// evaluateMMISignals
// ═════════════════════════════════════════════════════════════════════════════

async function evaluateMMISignals(claimId) {
  const claimService = _getClaimService();
  const aiService    = _getAiService();

  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  // Build context
  const claimSnapshot = {
    claimNumber:      claim.claimNumber,
    dateOfInjury:     claim.dateOfInjury,
    bodyPart:         claim.bodyPart,
    injuryType:       claim.injuryType,
    status:           claim.status,
    aww:              claim.aww,
    tdRate:           claim.tdRate,
    claimAgeDays:     Math.floor((Date.now() - new Date(claim.dateOfInjury).getTime()) / (1000 * 60 * 60 * 24)),
    diaries:          (claim.diaries || []).map(d => ({ type: d.type, status: d.status, dueDate: d.dueDate })),
  };

  let evaluation;
  try {
    evaluation = await aiService._callClaude(MMI_SYSTEM_PROMPT, JSON.stringify(claimSnapshot), 1200);
  } catch (err) {
    logger.error({ msg: 'mmiService.evaluateMMISignals: AI call failed', claimId, err: err.message });
    throw new Error(`MMI AI evaluation failed: ${err.message}`);
  }

  const signals       = evaluation.signals || [];
  const recommendation = evaluation.recommendation || 'no_action';
  const rationale      = evaluation.rationale || '';

  // Write mmi_evaluations row
  const { data: row, error } = await supabase
    .from('mmi_evaluations')
    .insert({
      claim_id:       claimId,
      evaluated_at:   new Date().toISOString(),
      signals,
      signal_count:   signals.length,
      recommendation,
      rationale,
    })
    .select()
    .single();

  if (error) throw new Error(`mmiService: insert failed — ${error.message}`);

  // Create diaries based on recommendation
  const today = new Date().toISOString().split('T')[0];

  if (recommendation === 'solicit_pr4') {
    await _createDiary(
      claimId, 'MMI_PR4_REVIEW', _addCalendarDays(today, 5), 'HIGH',
      `MMI signals detected (${signals.length} signals) — consider PR-4 solicitation. Review AI evaluation and decide.`,
    );
  } else if (recommendation === 'monitor') {
    await _createDiary(
      claimId, 'MMI_MONITOR', _addCalendarDays(today, 30), 'MEDIUM',
      `MMI approach monitoring — ${signals.length} signals detected. Re-evaluate in 30 days.`,
    );
  }
  // no_action: no diary created

  await _writeAuditLog(
    'mmi_evaluated', 'mmi_evaluation', row.id,
    `MMI evaluation: ${recommendation} (${signals.length} signals)`,
    { signals: signals.map(s => s.type), recommendation },
  );

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'mmi_evaluated',
    timestamp: new Date().toISOString(),
    data:      { evaluationId: row.id, recommendation, signalCount: signals.length },
  });

  logger.info({ msg: 'mmiService.evaluateMMISignals: complete', claimId, recommendation, signalCount: signals.length });

  return row;
}

// ═════════════════════════════════════════════════════════════════════════════
// solicitPR4
// ═════════════════════════════════════════════════════════════════════════════

async function solicitPR4(claimId, mmiEvaluationId, { physicianName, physicianFax, physicianAddress }) {
  const claimService = _getClaimService();
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const today          = new Date().toISOString().split('T')[0];
  const responseDueDate = _addCalendarDays(today, 30);

  // Generate PR-4 solicitation letter PDF
  let pdfBuffer = null;
  try {
    pdfBuffer = await _generatePR4Letter(claim, physicianName, responseDueDate);
  } catch (err) {
    logger.error({ msg: 'mmiService.solicitPR4: PDF generation failed (non-fatal)', err: err.message });
  }

  // Send via Lob
  let lobLetterId = null;
  try {
    const lobResult = await lobService.sendLetter('pr4_solicitation', claimId, 'provider', {
      recipientName:    physicianName,
      recipientAddress: physicianAddress || '',
      pdfBuffer,
    });
    lobLetterId = lobResult.letterId;
  } catch (err) {
    logger.error({ msg: 'mmiService.solicitPR4: lob failed (non-fatal)', err: err.message });
  }

  // Insert pr4_solicitations row
  const { data: pr4, error } = await supabase
    .from('pr4_solicitations')
    .insert({
      claim_id:          claimId,
      mmi_evaluation_id: mmiEvaluationId,
      solicitation_date: today,
      response_due_date: responseDueDate,
      physician_name:    physicianName,
      physician_fax:     physicianFax || null,
      physician_address: physicianAddress || null,
      method:            'lob',
      lob_letter_id:     lobLetterId,
      status:            'sent',
      created_at:        new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`mmiService.solicitPR4: insert failed — ${error.message}`);

  // Update mmi_evaluations adjuster_action
  if (mmiEvaluationId) {
    await supabase.from('mmi_evaluations')
      .update({ adjuster_action: 'pr4_solicited', acted_at: new Date().toISOString() })
      .eq('id', mmiEvaluationId);
  }

  // Diary: response due
  await _createDiary(
    claimId, 'PR4_RESPONSE_DUE', responseDueDate, 'HIGH',
    `PR-4 response due: ${responseDueDate}. Follow up with ${physicianName} if not received.`,
  );

  await _writeAuditLog(
    'pr4_solicited', 'pr4_solicitation', pr4.id,
    `PR-4 solicited from ${physicianName}. Response due: ${responseDueDate}`,
    { physicianName, responseDueDate, lobLetterId },
  );

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'pr4_solicited',
    timestamp: new Date().toISOString(),
    data:      { pr4Id: pr4.id, physicianName, responseDueDate },
  });

  logger.info({ msg: 'mmiService.solicitPR4: complete', claimId, pr4Id: pr4.id, responseDueDate });

  return pr4;
}

// ── PR-4 solicitation letter PDF ─────────────────────────────────────────────

async function _generatePR4Letter(claim, physicianName, responseDueDate) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  // Date
  page.drawText(_formatDate(new Date().toISOString()), { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 20;

  // Recipient
  page.drawText(physicianName, { x: MARGIN, y, size: 11, font: fonts.bold, color: DARK });
  y -= 14;
  page.drawText('Via: Lob Print & Mail', { x: MARGIN, y, size: 9, font: fonts.regular, color: GRAY });
  y -= 24;

  // Subject
  page.drawText('Re: Request for Permanent and Stationary Report (PR-4)', { x: MARGIN, y, size: 11, font: fonts.bold, color: BLUE });
  y -= 14;

  const emp = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';

  const lines = [
    `Claim Number: ${claim.claimNumber}`,
    `Injured Worker: ${empName}`,
    `Date of Injury: ${_formatDate(claim.dateOfInjury)}`,
    `Body Part(s): ${claim.bodyPart || 'See accepted claim'}`,
    '',
    `Dear Dr. ${physicianName.split(' ').pop()},`,
    '',
    'You are the primary treating physician for the above-referenced injured worker.',
    'We are writing to request your opinion regarding whether the injured worker has',
    'reached Maximum Medical Improvement (Permanent and Stationary status) pursuant',
    'to the California Labor Code.',
    '',
    'Please complete and return a PR-4 (Physician\'s Return-to-Work & Voucher Report)',
    'addressing the following:',
    '',
    '  1. Whether the injured worker is Permanent and Stationary (P&S)',
    '  2. Whole Person Impairment (WPI) percentage using AMA Guides, 5th Edition',
    '  3. Work restrictions (permanent and temporary)',
    '  4. Future medical treatment recommendations',
    '  5. Apportionment to pre-existing conditions, if applicable (LC §4663/4664)',
    '',
    `Please provide your report within 30 days of receipt of this letter`,
    `(by ${_formatDate(responseDueDate)}).`,
    '',
    'If you have any questions, please contact our office at the number above.',
    '',
    'Thank you for your continued care of this injured worker.',
    '',
    'Sincerely,',
    '',
    `${config.adjuster.name || 'Claims Administrator'}`,
    'HomeCare TPA',
  ];

  for (const line of lines) {
    page.drawText(line, { x: MARGIN, y, size: 9.5, font: fonts.regular, color: DARK });
    y -= 13;
    if (y < MARGIN + 40) break;
  }

  return Buffer.from(await pdfDoc.save());
}

// ═════════════════════════════════════════════════════════════════════════════
// recordPR4Response
// ═════════════════════════════════════════════════════════════════════════════

async function recordPR4Response(pr4Id, { wpi, workRestrictions, futureMedical, apportionmentNoted, pAndSDate, confirmedBy }) {
  const { data: pr4, error: fetchErr } = await supabase
    .from('pr4_solicitations')
    .select('*')
    .eq('id', pr4Id)
    .single();

  if (fetchErr || !pr4) throw new Error(`PR-4 solicitation not found: ${pr4Id}`);
  if (pr4.status === 'received') throw new Error('PR-4 response already recorded');

  const now = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('pr4_solicitations')
    .update({
      response_received_at: now,
      wpi:                  wpi != null ? parseFloat(wpi) : null,
      work_restrictions:    workRestrictions || null,
      future_medical:       futureMedical || null,
      apportionment_noted:  apportionmentNoted || false,
      status:               'received',
    })
    .eq('id', pr4Id);

  if (updateErr) throw new Error(`mmiService.recordPR4Response: update failed — ${updateErr.message}`);

  // Close response due diary
  await _closeDiary(pr4.claim_id, 'PR4_RESPONSE_DUE');

  // Primary review diary
  const apportionLabel = apportionmentNoted ? 'Yes' : 'No';
  await _createDiary(
    pr4.claim_id, 'PR4_REVIEW', _addCalendarDays(now.split('T')[0], 7), 'HIGH',
    `PR-4 received. WPI: ${wpi != null ? wpi + '%' : 'Not stated'}. Review for PD calculation, future medical, work restrictions. Apportion: ${apportionLabel}. Proceed to PD evaluation when ready.`,
  );

  // Apportionment diary (additional)
  if (apportionmentNoted) {
    await _createDiary(
      pr4.claim_id, 'PR4_APPORTIONMENT', _addCalendarDays(now.split('T')[0], 14), 'HIGH',
      'Apportionment noted in PR-4 — QME/AME may be needed to formalize.',
    );
  }

  await _writeAuditLog(
    'pr4_response_received', 'pr4_solicitation', pr4Id,
    `PR-4 response received. WPI: ${wpi}%, Apportionment: ${apportionLabel}`,
    { wpi, workRestrictions, futureMedical, apportionmentNoted },
  );

  await supabase.from('claim_events').insert({
    claim_id:  pr4.claim_id,
    type:      'pr4_response_received',
    timestamp: now,
    data:      { pr4Id, wpi, apportionmentNoted },
  });

  // M14.5 P&S write-through. PR-4 is the physician's P&S declaration,
  // so source is 'pr_4'. We write only when the caller supplied an
  // explicit pAndSDate — we do NOT synthesize a P&S date from
  // response_received_at (would pollute the claim with false dates).
  // Priority: pr_4 overwrites treating_physician/award_document/adjuster_entry
  // but defers to qme_report.
  if (pAndSDate) {
    try {
      await _getPdService().setPAndSDate(pr4.claim_id, {
        date:        pAndSDate,
        source:      'pr_4',
        confirmedBy: confirmedBy || null,
      });
    } catch (err) {
      // Silent failure here would leave claims.p_and_s_date null when it
      // should have been set, desynchronizing TD termination / PD advance
      // start / MMI workflow. Surface on BOTH logger.error (structured) and
      // console.error (raw stderr) so the signal survives any log routing
      // misconfiguration.
      const payload = {
        msg:      'mmiService.recordPR4Response: P&S write-through failed (non-fatal)',
        err:      err.message,
        stack:    err.stack,
        claim_id: pr4.claim_id,
        pr4Id,
        pAndSDate,
      };
      logger.error(payload);
      console.error('P&S_WRITE_THROUGH_FAILED', payload, err);
    }
  }

  logger.info({ msg: 'mmiService.recordPR4Response: complete', pr4Id, wpi, apportionmentNoted });

  // Return updated row
  const { data: updated } = await supabase.from('pr4_solicitations').select('*').eq('id', pr4Id).single();
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// dismissMMIEvaluation
// ═════════════════════════════════════════════════════════════════════════════

async function dismissMMIEvaluation(mmiEvaluationId, adjusterId, note) {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('mmi_evaluations')
    .update({
      adjuster_action: 'dismissed',
      adjuster_id:     adjusterId,
      adjuster_note:   note || null,
      acted_at:        now,
    })
    .eq('id', mmiEvaluationId);

  if (error) throw new Error(`mmiService.dismissMMIEvaluation: ${error.message}`);

  await _writeAuditLog(
    'mmi_dismissed', 'mmi_evaluation', mmiEvaluationId,
    `MMI evaluation dismissed: ${note || 'No note'}`,
    { adjusterId, note },
  );

  logger.info({ msg: 'mmiService.dismissMMIEvaluation: complete', mmiEvaluationId });

  return { id: mmiEvaluationId, adjuster_action: 'dismissed' };
}

// ═════════════════════════════════════════════════════════════════════════════
// Read operations
// ═════════════════════════════════════════════════════════════════════════════

async function getMMIEvaluations(claimId) {
  const { data, error } = await supabase
    .from('mmi_evaluations')
    .select('*')
    .eq('claim_id', claimId)
    .order('evaluated_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

async function getPR4Solicitations(claimId) {
  const { data, error } = await supabase
    .from('pr4_solicitations')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  evaluateMMISignals,
  solicitPR4,
  recordPR4Response,
  dismissMMIEvaluation,
  getMMIEvaluations,
  getPR4Solicitations,
  _addCalendarDays,
};
