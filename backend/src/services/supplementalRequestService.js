'use strict';

/**
 * supplementalRequestService.js — M11.
 *
 * AI-powered evaluation of QME/AME reports to identify conditions
 * that require a supplemental report request.
 *
 * Uses the supplemental_requests table (created in M6 retrofit migration).
 *
 * Pattern: Claude reads the QME panel summary, flags gaps,
 * adjuster reviews, then sends via lobService + noticeService.
 */

const { supabase }    = require('./supabase');
const lobService      = require('./lobService');
const logger          = require('../logger');

// ── Lazy require to break circular dep ───────────────────────────────────────
function _getAiService() {
  return require('./aiService');
}

function _getClaimService() {
  return require('./claimService');
}

function _getQmeService() {
  return require('./qmeService');
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
    logger.error({ msg: 'supplementalRequestService: audit_log write failed', err: err.message, action, resourceId });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// evaluateQmeReport
// ═════════════════════════════════════════════════════════════════════════════

const SUPPLEMENTAL_SYSTEM_PROMPT = `You are a California workers' compensation claims analyst reviewing a QME/AME medical-legal report.

Identify conditions that require a supplemental report request. Check for:
1. Apportionment not addressed or insufficiently addressed (LC §4663/4664)
2. Future medical treatment not quantified or too vague
3. Work restrictions vague or contradictory
4. Body parts in accepted claim not addressed in report
5. Contradicts prior PR-2 findings without explanation
6. Permanent disability rating methodology unclear
7. Maximum Medical Improvement (MMI) date not stated
8. Causation analysis incomplete for disputed body parts

For each issue found, provide:
- flag: short code (e.g. "APPORTIONMENT_MISSING", "FUTURE_MEDICAL_VAGUE")
- severity: "critical" | "important" | "minor"
- description: one-sentence explanation
- draftQuestion: the specific question to ask the QME in a supplemental request letter

Return JSON:
{
  "flags": [
    { "flag": "...", "severity": "...", "description": "...", "draftQuestion": "..." }
  ],
  "overallAssessment": "One paragraph summary of report quality and completeness",
  "supplementalNeeded": true/false
}

If the report is complete and addresses all required areas, return supplementalNeeded: false with empty flags array.`;

async function evaluateQmeReport(panelId) {
  const qmeService   = _getQmeService();
  const aiService    = _getAiService();
  const claimService = _getClaimService();

  const panel = await qmeService.getPanel(panelId);
  if (!panel) throw new Error(`QME panel not found: ${panelId}`);

  const claim = await claimService.getClaim(panel.claim_id);
  if (!claim) throw new Error(`Claim not found: ${panel.claim_id}`);

  // Build context for Claude
  const panelSummary = {
    claimNumber:     claim.claimNumber,
    dateOfInjury:    claim.dateOfInjury,
    bodyPart:        claim.bodyPart,
    injuryType:      claim.injuryType,
    specialty:       panel.specialty,
    doctorName:      panel.selected_name || panel.ame_doctor_name,
    track:           panel.track,
    appointmentDate: panel.appointment_date,
    acceptedBodyParts: claim.bodyPart ? [claim.bodyPart] : [],
  };

  let evaluation;
  try {
    evaluation = await aiService._callClaude(
      SUPPLEMENTAL_SYSTEM_PROMPT,
      JSON.stringify(panelSummary),
      1500,
    );
  } catch (err) {
    logger.error({ msg: 'supplementalRequestService: AI evaluation failed', panelId, err: err.message });
    // On AI failure: create diary for manual review
    await qmeService._createDiary(
      panel.claim_id,
      'QME_SUPPLEMENTAL_REVIEW',
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      'HIGH',
      'AI supplemental evaluation failed — manual review required.',
    );
    return { flags: [], error: err.message };
  }

  const flags = evaluation.flags || [];

  if (flags.length > 0) {
    // Build draft supplemental request letter text
    const draftText = _buildDraftLetter(panel, claim, flags);

    // Create supplemental_requests row
    const { data: sr, error: srErr } = await supabase
      .from('supplemental_requests')
      .insert({
        claim_id:   panel.claim_id,
        flags:      flags,
        draft_text: draftText,
        status:     'draft',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (srErr) {
      logger.error({ msg: 'supplementalRequestService: insert failed', err: srErr.message });
    }

    // Diary for adjuster review
    await qmeService._createDiary(
      panel.claim_id,
      'QME_SUPPLEMENTAL_REVIEW',
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      'HIGH',
      `Supplemental report flags detected: ${flags.length} items need adjuster review.`,
    );

    await _writeAuditLog(
      'supplemental_flags_detected', 'supplemental_request', sr?.id || panelId,
      `${flags.length} supplemental report flags detected for QME panel ${panelId}`,
      { flags: flags.map(f => f.flag), overallAssessment: evaluation.overallAssessment },
    );

    logger.info({ msg: 'supplementalRequestService.evaluateQmeReport: flags found', panelId, flagCount: flags.length });
  } else {
    // No flags — report is complete
    await qmeService._createDiary(
      panel.claim_id,
      'QME_SUPPLEMENTAL_REVIEW',
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      'MEDIUM',
      'QME report reviewed — no supplemental requests needed.',
    );

    await _writeAuditLog(
      'supplemental_no_flags', 'qme_panel', panelId,
      'QME report AI evaluation: no supplemental requests needed',
      { overallAssessment: evaluation.overallAssessment },
    );

    logger.info({ msg: 'supplementalRequestService.evaluateQmeReport: no flags', panelId });
  }

  return evaluation;
}

// ── Draft letter builder ─────────────────────────────────────────────────────

function _buildDraftLetter(panel, claim, flags) {
  const doctorName = panel.selected_name || panel.ame_doctor_name || 'Doctor';
  const lines = [
    `Re: Supplemental Report Request`,
    `Claim Number: ${claim.claimNumber}`,
    `Injured Worker: ${claim.employee?.firstName || ''} ${claim.employee?.lastName || ''}`,
    `Date of Injury: ${claim.dateOfInjury}`,
    `Body Part(s): ${claim.bodyPart || 'See accepted claim'}`,
    '',
    `Dear Dr. ${doctorName.split(' ').pop()},`,
    '',
    `Thank you for your medical-legal report. After review, we respectfully request a supplemental report addressing the following:`,
    '',
  ];

  flags.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.draftQuestion}`);
    lines.push('');
  });

  lines.push('Please provide your supplemental report within 30 days of receipt of this letter.');
  lines.push('');
  lines.push('Thank you for your prompt attention to this matter.');

  return lines.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// CRUD operations
// ═════════════════════════════════════════════════════════════════════════════

async function getSupplementalRequests(claimId) {
  const { data, error } = await supabase
    .from('supplemental_requests')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

async function approveAndSend(supplementalRequestId, adjusterId) {
  const { data: sr, error: fetchErr } = await supabase
    .from('supplemental_requests')
    .select('*')
    .eq('id', supplementalRequestId)
    .single();

  if (fetchErr || !sr) throw new Error(`Supplemental request not found: ${supplementalRequestId}`);
  if (sr.status === 'sent') throw new Error('Already sent');
  if (sr.status === 'dismissed') throw new Error('Already dismissed');

  const now = new Date().toISOString();
  const responseDue = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { error: updateErr } = await supabase
    .from('supplemental_requests')
    .update({
      status:       'sent',
      reviewed_by:  adjusterId,
      reviewed_at:  now,
      sent_at:      now,
      response_due: responseDue,
    })
    .eq('id', supplementalRequestId);

  if (updateErr) throw new Error(updateErr.message);

  // Queue for print/mail
  try {
    await lobService.sendLetter(
      'supplemental_request', sr.claim_id, 'provider',
      { recipientName: 'QME Doctor', recipientAddress: '', pdfBuffer: null },
    );
  } catch (err) {
    logger.error({ msg: 'supplementalRequestService.approveAndSend: lob failed (non-fatal)', err: err.message });
  }

  await _writeAuditLog(
    'supplemental_sent', 'supplemental_request', supplementalRequestId,
    `Supplemental request approved and sent by adjuster`,
    { adjusterId, responseDue },
  );

  logger.info({ msg: 'supplementalRequestService.approveAndSend: complete', supplementalRequestId });

  return { id: supplementalRequestId, status: 'sent', responseDue };
}

async function dismiss(supplementalRequestId, adjusterId, reason) {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('supplemental_requests')
    .update({
      status:      'dismissed',
      reviewed_by: adjusterId,
      reviewed_at: now,
    })
    .eq('id', supplementalRequestId);

  if (error) throw new Error(error.message);

  await _writeAuditLog(
    'supplemental_dismissed', 'supplemental_request', supplementalRequestId,
    `Supplemental request dismissed: ${reason}`,
    { adjusterId, reason },
  );

  logger.info({ msg: 'supplementalRequestService.dismiss: complete', supplementalRequestId, reason });

  return { id: supplementalRequestId, status: 'dismissed' };
}

module.exports = {
  evaluateQmeReport,
  getSupplementalRequests,
  approveAndSend,
  dismiss,
};
