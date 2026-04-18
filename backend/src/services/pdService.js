'use strict';

/**
 * pdService.js — M13 Stipulation + PD Closure + PD Advances.
 *
 * PD advance deadline: 14 CALENDAR days from TD end (LC §4650(b)).
 * 10% penalty if missed. Diary must have no_snooze: true.
 *
 * 2026 PD advance rates (updated each January):
 *   Ratings 1%–69.75%:  min $160/wk, max $290/wk
 *   Ratings 70%+:       min $240/wk, max $435/wk
 *   Base rate: 2/3 AWW, capped at statutory max, floored at statutory min.
 *
 * Stip document: includes LC §5405 statute of limitations (DOI + 5 years),
 * DWC I&A block for unrepresented workers.
 *
 * EAMS filing is always manual — system prepares package, adjuster files.
 * Represented workers: stip goes to attorney only, never direct to worker.
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { supabase } = require('./supabase');
const lobService   = require('./lobService');
const config       = require('../config');
const logger       = require('../logger');

// ── Lazy requires ────────────────────────────────────────────────────────────
function _getClaimService() { return require('./claimService'); }

// ── 2026 PD Advance Statutory Rates ──────────────────────────────────────────
const PD_RATES_2026 = {
  low: { min: 160, max: 290, threshold: 69.75 },   // Ratings 1%–69.75%
  high: { min: 240, max: 435, threshold: 70 },      // Ratings 70%+
};

// ── PD Advance Cap Policy (M14.5) ────────────────────────────────────────────
// LC §4650(b)(1) "reasonable estimate" — administrative practice.
// 15% represented reserve preserves AA fee at settlement.
// 100% unrepresented because no AA fee to reserve.
// Overridable per-advance via cap_overridden / cap_override_pct on pd_advances.
const ADVANCE_CAP_POLICY = {
  REPRESENTED_PCT:   0.85,
  UNREPRESENTED_PCT: 1.00,
};

// ── Represented check ────────────────────────────────────────────────────────
// Duplicated here because cnrService._isRepresented is its own private helper.
// M17B Master-Context deferred task: consolidate attorney_represented into a
// single claim column and replace this OR-chain + the twin in cnrService with
// a shared helper.
function _isRepresented(claim) {
  if (!claim) return false;
  return !!(
    claim.attorney_represented ||
    claim.attorneyName ||
    claim.attorney_name ||
    claim.representedBy
  );
}

// ── Cap policy resolution ────────────────────────────────────────────────────
// Per-advance override wins. Otherwise represented = 85%, unrepresented = 100%.
// advanceRow may be null when initiating an advance (the row doesn't exist yet).
function _resolveCapPolicy(claim, advanceRow) {
  if (advanceRow && advanceRow.cap_overridden && advanceRow.cap_override_pct != null) {
    return { pct: parseFloat(advanceRow.cap_override_pct), source: 'override' };
  }
  if (_isRepresented(claim)) {
    return { pct: ADVANCE_CAP_POLICY.REPRESENTED_PCT, source: 'represented' };
  }
  return { pct: ADVANCE_CAP_POLICY.UNREPRESENTED_PCT, source: 'unrepresented' };
}

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

// ── DWC I&A Block (structurally required for unrepresented workers) ──────────
const DWC_IA_BLOCK = [
  'INFORMATION & ASSISTANCE (I&A) — YOUR RIGHT TO FREE HELP',
  '',
  'You have the right to receive free information and assistance from the',
  'Division of Workers\' Compensation (DWC) Information & Assistance Unit.',
  '',
  'The I&A officer can help you understand your rights, file claims and',
  'applications, and navigate the workers\' compensation process at no cost.',
  '',
  'Contact DWC Information & Assistance:',
  '  Phone:   1-800-736-7401 (toll-free)',
  '  Website: www.dir.ca.gov/dwc/iwguides.html',
  '  Office:  Find your local I&A office at www.dir.ca.gov/dwc/IandA.html',
  '',
  'You may also consult an attorney. If you do not have an attorney, the',
  'California State Bar Lawyer Referral Service can be reached at 1-866-442-2529.',
];

function _drawIABlock(page, y, fonts) {
  const lineH  = 11;
  const blockH = DWC_IA_BLOCK.length * lineH + 20;
  const boxY   = y - blockH + 6;
  page.drawRectangle({
    x: MARGIN, y: boxY, width: PAGE_W - MARGIN * 2, height: blockH,
    color: rgb(0.95, 0.97, 1.0), borderColor: BLUE, borderWidth: 0.5,
  });
  y -= 12;
  for (const line of DWC_IA_BLOCK) {
    if (line === DWC_IA_BLOCK[0]) {
      page.drawText(line, { x: MARGIN + 8, y, size: 8, font: fonts.bold, color: BLUE });
    } else {
      page.drawText(line, { x: MARGIN + 8, y, size: 7.5, font: fonts.regular, color: DARK });
    }
    y -= lineH;
  }
  return y - 6;
}

// ── Audit log ────────────────────────────────────────────────────────────────
async function _writeAuditLog(action, resourceType, resourceId, description, newValue) {
  try {
    await supabase.from('audit_log').insert({
      action, resource_type: resourceType, resource_id: resourceId,
      description, new_value: newValue, user_role: 'system',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'pdService: audit_log write failed', err: err.message, action, resourceId });
  }
}

// ── Diary helper ─────────────────────────────────────────────────────────────
async function _createDiary(claimId, diaryType, dueDate, priority, notes, opts = {}) {
  const row = {
    claim_id: claimId, diary_type: diaryType, due_date: dueDate,
    assigned_to: 'system@homecaretpa.com', priority, notes,
    status: 'open', no_snooze: opts.noSnooze || false,
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: new Date().toISOString(),
  };
  await supabase.from('diaries').insert(row);
  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'diary_created', timestamp: new Date().toISOString(),
    data: { diaryType, dueDate, priority, noSnooze: row.no_snooze },
  });
  return row;
}

async function _closeDiary(claimId, diaryType) {
  await supabase.from('diaries')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('claim_id', claimId).eq('diary_type', diaryType).eq('status', 'open');
}

// ── Calendar day math ────────────────────────────────────────────────────────
function _addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ── PD weekly rate helper ────────────────────────────────────────────────────
function _computePDWeeklyRate(aww, pdPercent) {
  const tier = pdPercent >= PD_RATES_2026.high.threshold ? PD_RATES_2026.high : PD_RATES_2026.low;
  const raw  = (aww || 0) * (2 / 3);
  return Math.round(Math.max(tier.min, Math.min(tier.max, raw)) * 100) / 100;
}

// ═════════════════════════════════════════════════════════════════════════════
// calculatePD
// ═════════════════════════════════════════════════════════════════════════════
async function calculatePD(claimId, pr4Id, { apportionmentPercent }) {
  const claimService = _getClaimService();
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  // Fetch PR-4 for WPI
  const { data: pr4, error: pr4Err } = await supabase
    .from('pr4_solicitations').select('*').eq('id', pr4Id).single();
  if (pr4Err || !pr4) throw new Error(`PR-4 not found: ${pr4Id}`);
  if (pr4.wpi == null) throw new Error('PR-4 has no WPI recorded');

  const wpi = parseFloat(pr4.wpi);

  // Compute age at DOI
  const emp = claim.employee || {};
  let ageAtDoi = null;
  if (emp.dob && claim.dateOfInjury) {
    const dob = new Date(emp.dob + 'T00:00:00');
    const doi = new Date(claim.dateOfInjury + 'T00:00:00');
    ageAtDoi = doi.getFullYear() - dob.getFullYear();
    const m = doi.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && doi.getDate() < dob.getDate())) ageAtDoi--;
  }

  // PDRS lookup — find closest match
  const { data: pdrsRows } = await supabase
    .from('pdrs_lookup')
    .select('*')
    .eq('wpi_percent', wpi)
    .eq('occupation_group', 1);

  let pdPercent, pdWeeks;
  if (pdrsRows && pdrsRows.length > 0) {
    // Use age_factor = 1.0 (closest match for now; real impl uses age lookup)
    const row = pdrsRows[0];
    pdPercent = parseFloat(row.pd_percent);
    pdWeeks   = parseFloat(row.weekly_pd_weeks);
  } else {
    // Fallback: linear approximation when WPI not in table
    // PD% ≈ WPI * 1.4 (rough 2005 PDRS linear estimate for group 1)
    pdPercent = Math.round(wpi * 1.4 * 100) / 100;
    // Weeks ≈ PD% * 4 (rough estimate)
    pdWeeks = Math.round(pdPercent * 4 * 100) / 100;
  }

  // PD weekly rate
  const pdWeeklyRate = _computePDWeeklyRate(claim.aww, pdPercent);
  const pdTotalValue = Math.round(pdWeeks * pdWeeklyRate * 100) / 100;

  // Apportionment
  const apport = parseFloat(apportionmentPercent) || 0;
  const adjustedPdPercent  = Math.round(pdPercent * (1 - apport / 100) * 100) / 100;
  const adjustedTotalValue = Math.round(pdWeeks * (1 - apport / 100) * pdWeeklyRate * 100) / 100;

  // Write pd_evaluations row
  const { data: evalRow, error: evalErr } = await supabase
    .from('pd_evaluations')
    .insert({
      claim_id:              claimId,
      pr4_id:                pr4Id,
      wpi,
      age_at_doi:            ageAtDoi,
      occupation_group:      1,
      pd_percent:            pdPercent,
      pd_weeks:              pdWeeks,
      pd_weekly_rate:        pdWeeklyRate,
      pd_total_value:        pdTotalValue,
      apportionment_percent: apport,
      adjusted_pd_percent:   adjustedPdPercent,
      adjusted_total_value:  adjustedTotalValue,
      calculated_at:         new Date().toISOString(),
    })
    .select()
    .single();

  if (evalErr) throw new Error(`pdService.calculatePD: insert failed — ${evalErr.message}`);

  // Diary
  const apportLabel = apport > 0 ? `Apportionment: ${apport}%. Adjusted total: $${adjustedTotalValue}. ` : '';
  await _createDiary(
    claimId, 'PD_CALCULATED', _addCalendarDays(new Date().toISOString().split('T')[0], 5), 'HIGH',
    `PD calculated: ${pdPercent}% (${pdWeeks} weeks @ $${pdWeeklyRate}/wk = $${pdTotalValue}). ${apportLabel}Review and initiate PD advances if TD has ended.`,
  );

  // Update claim status to pd_evaluation
  await supabase.from('claims')
    .update({ status: 'pd_evaluation', updated_at: new Date().toISOString() })
    .eq('id', claimId);

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'status_changed', timestamp: new Date().toISOString(),
    data: { from: claim.status, to: 'pd_evaluation', changedBy: 'system' },
  });

  await _writeAuditLog(
    'pd_calculated', 'pd_evaluation', evalRow.id,
    `PD calculated: ${pdPercent}% → $${pdTotalValue} (apport ${apport}% → $${adjustedTotalValue})`,
    { wpi, pdPercent, pdWeeks, pdWeeklyRate, pdTotalValue, apport, adjustedTotalValue },
  );

  logger.info({ msg: 'pdService.calculatePD: complete', claimId, pdPercent, pdTotalValue, adjustedTotalValue });

  return evalRow;
}

// ═════════════════════════════════════════════════════════════════════════════
// initiatePDAdvances
// ═════════════════════════════════════════════════════════════════════════════
async function initiatePDAdvances(claimId, pdEvaluationId, { tdEndDate }) {
  // Fetch PD evaluation for weekly rate
  const { data: pdEval, error: evalErr } = await supabase
    .from('pd_evaluations').select('*').eq('id', pdEvaluationId).single();
  if (evalErr || !pdEval) throw new Error(`PD evaluation not found: ${pdEvaluationId}`);

  // 14 CALENDAR days from TD end — LC §4650(b). NOT business days.
  const advanceDueDate = _addCalendarDays(tdEndDate, 14);
  const weeklyRate     = parseFloat(pdEval.pd_weekly_rate);

  const { data: advRow, error: advErr } = await supabase
    .from('pd_advances')
    .insert({
      claim_id:         claimId,
      pd_evaluation_id: pdEvaluationId,
      td_end_date:      tdEndDate,
      advance_due_date: advanceDueDate,
      weekly_rate:      weeklyRate,
      status:           'pending',
      created_at:       new Date().toISOString(),
    })
    .select()
    .single();

  if (advErr) throw new Error(`pdService.initiatePDAdvances: insert failed — ${advErr.message}`);

  // CRITICAL no-snooze diary — 10% penalty if missed
  await _createDiary(
    claimId, 'PD_ADVANCE_DUE', advanceDueDate, 'CRITICAL',
    `PD ADVANCE DUE: ${advanceDueDate}. First PD advance payment must issue by this date. 10% penalty if missed. LC §4650(b). Rate: $${weeklyRate}/wk.`,
    { noSnooze: true },
  );

  await _writeAuditLog(
    'pd_advance_initiated', 'pd_advance', advRow.id,
    `PD advance initiated. TD end: ${tdEndDate}. Due: ${advanceDueDate}. Rate: $${weeklyRate}/wk`,
    { tdEndDate, advanceDueDate, weeklyRate },
  );

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'pd_advance_initiated', timestamp: new Date().toISOString(),
    data: { pdAdvanceId: advRow.id, advanceDueDate, weeklyRate },
  });

  logger.info({ msg: 'pdService.initiatePDAdvances: complete', claimId, advanceDueDate, weeklyRate });

  return advRow;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordPDAdvancePayment
// ═════════════════════════════════════════════════════════════════════════════
async function recordPDAdvancePayment(pdAdvanceId) {
  const { data: adv, error: fetchErr } = await supabase
    .from('pd_advances').select('*').eq('id', pdAdvanceId).single();
  if (fetchErr || !adv) throw new Error(`PD advance not found: ${pdAdvanceId}`);
  if (adv.status !== 'pending') throw new Error(`PD advance is not pending: ${adv.status}`);

  const now = new Date().toISOString();

  const { error } = await supabase.from('pd_advances')
    .update({ first_payment_at: now, status: 'active' })
    .eq('id', pdAdvanceId);
  if (error) throw new Error(`pdService.recordPDAdvancePayment: ${error.message}`);

  await _closeDiary(adv.claim_id, 'PD_ADVANCE_DUE');

  await _writeAuditLog(
    'pd_advance_payment', 'pd_advance', pdAdvanceId,
    `PD advance first payment recorded. Rate: $${adv.weekly_rate}/wk`,
    { firstPaymentAt: now },
  );

  await supabase.from('claim_events').insert({
    claim_id: adv.claim_id, type: 'pd_advance_payment', timestamp: now,
    data: { pdAdvanceId, weeklyRate: adv.weekly_rate },
  });

  logger.info({ msg: 'pdService.recordPDAdvancePayment: complete', pdAdvanceId });

  const { data: updated } = await supabase.from('pd_advances').select('*').eq('id', pdAdvanceId).single();
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// waivePDAdvance
// ═════════════════════════════════════════════════════════════════════════════
async function waivePDAdvance(pdAdvanceId, adjusterId, reason) {
  const { data: adv, error: fetchErr } = await supabase
    .from('pd_advances').select('*').eq('id', pdAdvanceId).single();
  if (fetchErr || !adv) throw new Error(`PD advance not found: ${pdAdvanceId}`);

  const now = new Date().toISOString();

  const { error } = await supabase.from('pd_advances')
    .update({ status: 'waived', waived_reason: reason || null })
    .eq('id', pdAdvanceId);
  if (error) throw new Error(`pdService.waivePDAdvance: ${error.message}`);

  await _closeDiary(adv.claim_id, 'PD_ADVANCE_DUE');

  await _writeAuditLog(
    'pd_advance_waived', 'pd_advance', pdAdvanceId,
    `PD advance waived by adjuster: ${reason || 'No reason'}`,
    { adjusterId, reason },
  );

  logger.info({ msg: 'pdService.waivePDAdvance: complete', pdAdvanceId, reason });

  return { id: pdAdvanceId, status: 'waived' };
}

// ═════════════════════════════════════════════════════════════════════════════
// createStipulation
// ═════════════════════════════════════════════════════════════════════════════
async function createStipulation(claimId, pdEvaluationId, { futureMedical, futureMedicalDesc, bodyPartsAccepted }) {
  const claimService = _getClaimService();
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  // Fetch PD evaluation
  const { data: pdEval, error: evalErr } = await supabase
    .from('pd_evaluations').select('*').eq('id', pdEvaluationId).single();
  if (evalErr || !pdEval) throw new Error(`PD evaluation not found: ${pdEvaluationId}`);

  const pdPercent    = parseFloat(pdEval.adjusted_pd_percent ?? pdEval.pd_percent);
  const pdTotalValue = parseFloat(pdEval.adjusted_total_value ?? pdEval.pd_total_value);
  const parts        = bodyPartsAccepted || (claim.bodyPart ? [claim.bodyPart] : []);

  // Create stipulations row
  const { data: stip, error: stipErr } = await supabase
    .from('stipulations')
    .insert({
      claim_id:           claimId,
      pd_evaluation_id:   pdEvaluationId,
      pd_percent:         pdPercent,
      pd_total_value:     pdTotalValue,
      future_medical:     futureMedical || false,
      future_medical_desc: futureMedicalDesc || null,
      body_parts_accepted: parts,
      status:             'draft',
      created_at:         new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    })
    .select()
    .single();

  if (stipErr) throw new Error(`pdService.createStipulation: insert failed — ${stipErr.message}`);

  // Generate stip document PDF
  try {
    await _generateStipDocument(claim, pdEval, stip);
  } catch (err) {
    logger.error({ msg: 'pdService.createStipulation: PDF gen failed (non-fatal)', err: err.message });
  }

  // Diary
  await _createDiary(
    claimId, 'STIP_DRAFTED', _addCalendarDays(new Date().toISOString().split('T')[0], 5), 'HIGH',
    `Stip drafted. PD: ${pdPercent}% = $${pdTotalValue}. Future medical: ${futureMedical ? 'Yes' : 'No'}. Send to worker for signature.`,
  );

  await _writeAuditLog(
    'stip_created', 'stipulation', stip.id,
    `Stipulation drafted: ${pdPercent}% PD = $${pdTotalValue}. Future medical: ${futureMedical ? 'Yes' : 'No'}`,
    { pdPercent, pdTotalValue, futureMedical, bodyParts: parts },
  );

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'stip_created', timestamp: new Date().toISOString(),
    data: { stipId: stip.id, pdPercent, pdTotalValue, futureMedical },
  });

  logger.info({ msg: 'pdService.createStipulation: complete', claimId, stipId: stip.id });

  return stip;
}

// ── Stip document PDF generator ──────────────────────────────────────────────

async function _generateStipDocument(claim, pdEval, stip) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  const emp     = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';

  // Title
  page.drawText('STIPULATION WITH REQUEST FOR AWARD', { x: MARGIN, y, size: 13, font: fonts.bold, color: BLUE });
  y -= 18;
  page.drawText(`Claim Number: ${claim.claimNumber}`, { x: MARGIN, y, size: 10, font: fonts.bold, color: DARK });
  y -= 14;

  // LC §5405 — Statute of limitations: DOI + 5 years
  const doi5yr = new Date(claim.dateOfInjury + 'T00:00:00');
  doi5yr.setFullYear(doi5yr.getFullYear() + 5);
  const lc5405Date = _formatDate(doi5yr.toISOString());

  const lines = [
    `Injured Worker: ${empName}`,
    `Date of Injury: ${_formatDate(claim.dateOfInjury)}`,
    `Employer: ${claim.employerName || ''}`,
    `Body Part(s): ${(stip.body_parts_accepted || []).join(', ') || claim.bodyPart || '—'}`,
    '',
    'The parties stipulate and agree as follows:',
    '',
    `1. The injured worker sustained injury arising out of and in the course of`,
    `   employment on ${_formatDate(claim.dateOfInjury)}.`,
    '',
    `2. The injured worker's permanent disability is rated at ${stip.pd_percent}%,`,
    `   with a total permanent disability value of $${parseFloat(stip.pd_total_value).toLocaleString()}.`,
    '',
  ];

  if (parseFloat(pdEval.apportionment_percent) > 0) {
    lines.push(`3. Apportionment of ${pdEval.apportionment_percent}% has been applied per LC §4663/4664.`);
    lines.push(`   Adjusted PD: ${pdEval.adjusted_pd_percent}% = $${parseFloat(pdEval.adjusted_total_value).toLocaleString()}.`);
    lines.push('');
  }

  const nextNum = parseFloat(pdEval.apportionment_percent) > 0 ? 4 : 3;

  if (stip.future_medical) {
    lines.push(`${nextNum}. Future medical treatment is reserved and shall remain open.`);
    if (stip.future_medical_desc) {
      lines.push(`   ${stip.future_medical_desc}`);
    }
    lines.push('');
    lines.push(`${nextNum + 1}. Upon approval by the WCAB, the claim shall be reclassified as`);
    lines.push(`   Future Medical Only.`);
  } else {
    lines.push(`${nextNum}. No future medical treatment is reserved. Upon approval by the WCAB,`);
    lines.push(`   the claim shall be closed.`);
  }

  lines.push('');
  lines.push('STATUTE OF LIMITATIONS NOTICE — LC §5405');
  lines.push(`Proceedings for the collection of benefits must be commenced within five`);
  lines.push(`years from the date of injury. The statute of limitations for this claim`);
  lines.push(`expires on ${lc5405Date}.`);
  lines.push('');
  lines.push('');
  lines.push('____________________________          ____________________________');
  lines.push('Injured Worker Signature               Date');
  lines.push('');
  lines.push('');
  lines.push('____________________________          ____________________________');
  lines.push('Claims Administrator Signature         Date');

  for (const line of lines) {
    if (y < MARGIN + 220) break; // Reserve space for I&A block
    const isHeader = line.startsWith('STIPULATION') || line.startsWith('STATUTE OF LIMITATIONS');
    page.drawText(line, {
      x: MARGIN, y, size: isHeader ? 10 : 9.5,
      font: isHeader ? fonts.bold : fonts.regular,
      color: isHeader ? BLUE : DARK,
    });
    y -= 13;
  }

  // DWC I&A block — structurally required for unrepresented workers
  y -= 10;
  _drawIABlock(page, y, fonts);

  // Write notice row for audit trail
  await supabase.from('notices').insert({
    claim_id:           claim.id,
    notice_type:        'stipulation',
    statutory_deadline: lc5405Date,
    generated_at:       new Date().toISOString(),
    pdf_buffer_b64:     Buffer.from(await pdfDoc.save()).toString('base64'),
  });

  return Buffer.from(await pdfDoc.save());
}

// ═════════════════════════════════════════════════════════════════════════════
// sendStipToWorker
// ═════════════════════════════════════════════════════════════════════════════
async function sendStipToWorker(stipId) {
  const { data: stip, error: fetchErr } = await supabase
    .from('stipulations').select('*').eq('id', stipId).single();
  if (fetchErr || !stip) throw new Error(`Stipulation not found: ${stipId}`);
  if (stip.status !== 'draft') throw new Error(`Cannot send stip in status: ${stip.status}`);

  const claimService = _getClaimService();
  const claim = await claimService.getClaim(stip.claim_id);
  if (!claim) throw new Error(`Claim not found: ${stip.claim_id}`);

  const now = new Date().toISOString();
  const emp = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';

  // Check if worker is represented (attorney on file)
  // attorneyName is not yet a formal claims column — check raw row for future-proofing
  const { data: rawClaim } = await supabase.from('claims').select('*').eq('id', stip.claim_id).single();
  const isRepresented = !!(rawClaim?.attorneyName || rawClaim?.attorney_name || claim.attorneyName || claim.representedBy);

  if (isRepresented) {
    // Represented worker: action item for attorney transmission only.
    // NEVER send directly to worker.
    await _createDiary(
      stip.claim_id, 'STIP_ATTORNEY_TRANSMIT',
      _addCalendarDays(now.split('T')[0], 3), 'HIGH',
      `Stip ready for attorney transmission. Worker is represented — do NOT contact worker directly. Send stip package to attorney for review and worker signature.`,
    );
  } else {
    // Unrepresented: send via Lob
    try {
      await lobService.sendLetter('stipulation', stip.claim_id, 'claimant', {
        recipientName: empName,
        recipientAddress: emp.address ? `${emp.address.line1 || ''}, ${emp.address.state || ''} ${emp.address.zip || ''}` : '',
        pdfBuffer: null,
      });
    } catch (err) {
      logger.error({ msg: 'pdService.sendStipToWorker: lob failed (non-fatal)', err: err.message });
    }

    await _createDiary(
      stip.claim_id, 'STIP_WORKER_FOLLOWUP',
      _addCalendarDays(now.split('T')[0], 21), 'MEDIUM',
      `Stip sent to worker ${_formatDate(now)}. Follow up if not signed within 21 days.`,
    );
  }

  await supabase.from('stipulations')
    .update({ status: 'sent_to_worker', updated_at: now })
    .eq('id', stipId);

  await _writeAuditLog(
    'stip_sent', 'stipulation', stipId,
    `Stip sent. Represented: ${isRepresented ? 'Yes (attorney action item)' : 'No (Lob mail)'}`,
    { isRepresented },
  );

  await supabase.from('claim_events').insert({
    claim_id: stip.claim_id, type: 'stip_sent', timestamp: now,
    data: { stipId, isRepresented },
  });

  logger.info({ msg: 'pdService.sendStipToWorker: complete', stipId, isRepresented });

  const { data: updated } = await supabase.from('stipulations').select('*').eq('id', stipId).single();
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordWorkerSignature
// ═════════════════════════════════════════════════════════════════════════════
async function recordWorkerSignature(stipId) {
  const { data: stip, error: fetchErr } = await supabase
    .from('stipulations').select('*').eq('id', stipId).single();
  if (fetchErr || !stip) throw new Error(`Stipulation not found: ${stipId}`);
  if (stip.status !== 'sent_to_worker') throw new Error(`Cannot record signature in status: ${stip.status}`);

  const now = new Date().toISOString();

  await supabase.from('stipulations')
    .update({ worker_signed_at: now, status: 'worker_signed', updated_at: now })
    .eq('id', stipId);

  await _closeDiary(stip.claim_id, 'STIP_WORKER_FOLLOWUP');
  await _closeDiary(stip.claim_id, 'STIP_ATTORNEY_TRANSMIT');

  await _createDiary(
    stip.claim_id, 'STIP_ADJUSTER_SIGN',
    _addCalendarDays(now.split('T')[0], 3), 'HIGH',
    'Worker signed stip. Adjuster signature needed to finalize.',
  );

  await _writeAuditLog('stip_worker_signed', 'stipulation', stipId, 'Worker signed stipulation', { signedAt: now });

  await supabase.from('claim_events').insert({
    claim_id: stip.claim_id, type: 'stip_worker_signed', timestamp: now,
    data: { stipId },
  });

  logger.info({ msg: 'pdService.recordWorkerSignature: complete', stipId });

  const { data: updated } = await supabase.from('stipulations').select('*').eq('id', stipId).single();
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordAdjusterSignature
// ═════════════════════════════════════════════════════════════════════════════
async function recordAdjusterSignature(stipId, adjusterId) {
  const { data: stip, error: fetchErr } = await supabase
    .from('stipulations').select('*').eq('id', stipId).single();
  if (fetchErr || !stip) throw new Error(`Stipulation not found: ${stipId}`);
  if (stip.status !== 'worker_signed') throw new Error(`Cannot sign stip in status: ${stip.status}`);

  const now = new Date().toISOString();

  await supabase.from('stipulations')
    .update({
      adjuster_signed_at: now,
      status: 'eams_ready',
      eams_package_ready: true,
      updated_at: now,
    })
    .eq('id', stipId);

  await _closeDiary(stip.claim_id, 'STIP_ADJUSTER_SIGN');

  // EAMS filing action item — always manual
  await _createDiary(
    stip.claim_id, 'EAMS_FILE', _addCalendarDays(now.split('T')[0], 7), 'HIGH',
    'EAMS filing package ready. File manually at DWC. Mark filed when complete.',
  );

  await _writeAuditLog(
    'stip_adjuster_signed', 'stipulation', stipId,
    `Adjuster signed stip. EAMS package ready for manual filing.`,
    { adjusterId, eamsReady: true },
  );

  await supabase.from('claim_events').insert({
    claim_id: stip.claim_id, type: 'stip_adjuster_signed', timestamp: now,
    data: { stipId, adjusterId, eamsReady: true },
  });

  logger.info({ msg: 'pdService.recordAdjusterSignature: complete', stipId });

  const { data: updated } = await supabase.from('stipulations').select('*').eq('id', stipId).single();
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordEAMSFiled
// ═════════════════════════════════════════════════════════════════════════════
async function recordEAMSFiled(stipId, { filedDate }) {
  const { data: stip, error: fetchErr } = await supabase
    .from('stipulations').select('*').eq('id', stipId).single();
  if (fetchErr || !stip) throw new Error(`Stipulation not found: ${stipId}`);
  if (!['eams_ready', 'adjuster_signed'].includes(stip.status)) {
    throw new Error(`Cannot file EAMS in status: ${stip.status}`);
  }

  const now = new Date().toISOString();

  await supabase.from('stipulations')
    .update({ eams_filed_at: filedDate, status: 'filed', updated_at: now })
    .eq('id', stipId);

  await _closeDiary(stip.claim_id, 'EAMS_FILE');

  // Update claim status based on future_medical flag
  const newClaimStatus = stip.future_medical ? 'future_medical_only' : 'closed';

  await supabase.from('claims')
    .update({ status: newClaimStatus, updated_at: now })
    .eq('id', stip.claim_id);

  await supabase.from('claim_events').insert({
    claim_id: stip.claim_id, type: 'status_changed', timestamp: now,
    data: { from: 'pd_evaluation', to: newClaimStatus, changedBy: 'system', reason: 'EAMS filed' },
  });

  await _writeAuditLog(
    'eams_filed', 'stipulation', stipId,
    `EAMS filed on ${filedDate}. Claim status → ${newClaimStatus}`,
    { filedDate, newClaimStatus, futureMedical: stip.future_medical },
  );

  await supabase.from('claim_events').insert({
    claim_id: stip.claim_id, type: 'eams_filed', timestamp: now,
    data: { stipId, filedDate },
  });

  logger.info({ msg: 'pdService.recordEAMSFiled: complete', stipId, filedDate, newClaimStatus });

  const { data: updated } = await supabase.from('stipulations').select('*').eq('id', stipId).single();
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// Read operations
// ═════════════════════════════════════════════════════════════════════════════
async function getPDEvaluation(claimId) {
  const { data, error } = await supabase
    .from('pd_evaluations').select('*').eq('claim_id', claimId)
    .order('calculated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data && data.length > 0) ? data[0] : null;
}

async function getStipulation(claimId) {
  const { data, error } = await supabase
    .from('stipulations').select('*').eq('claim_id', claimId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data && data.length > 0) ? data[0] : null;
}

async function getPDAdvances(claimId) {
  const { data, error } = await supabase
    .from('pd_advances').select('*').eq('claim_id', claimId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// ═════════════════════════════════════════════════════════════════════════════
// calculateStipValue — M19 thin wrapper over existing PD math
// ═════════════════════════════════════════════════════════════════════════════

async function calculateStipValue(claimId) {
  const pdEval = await getPDEvaluation(claimId);
  if (!pdEval) throw new Error(`No PD evaluation found for claim: ${claimId}`);

  const adjustedValue = parseFloat(pdEval.adjusted_total_value ?? pdEval.pd_total_value);
  const adjustedPct   = parseFloat(pdEval.adjusted_pd_percent ?? pdEval.pd_percent);

  return {
    claimId,
    pdEvaluationId:      pdEval.id,
    wpi:                 parseFloat(pdEval.wpi),
    pdPercent:           parseFloat(pdEval.pd_percent),
    pdWeeks:             parseFloat(pdEval.pd_weeks),
    pdWeeklyRate:        parseFloat(pdEval.pd_weekly_rate),
    pdTotalValue:        parseFloat(pdEval.pd_total_value),
    apportionmentPercent: parseFloat(pdEval.apportionment_percent || 0),
    adjustedPdPercent:   adjustedPct,
    adjustedTotalValue:  adjustedValue,
    stipValue:           adjustedValue,
  };
}

module.exports = {
  calculatePD,
  initiatePDAdvances,
  recordPDAdvancePayment,
  waivePDAdvance,
  createStipulation,
  sendStipToWorker,
  recordWorkerSignature,
  recordAdjusterSignature,
  recordEAMSFiled,
  getPDEvaluation,
  getStipulation,
  getPDAdvances,
  calculateStipValue,
  // Exported for tests
  _computePDWeeklyRate,
  _addCalendarDays,
  _isRepresented,
  _resolveCapPolicy,
  PD_RATES_2026,
  ADVANCE_CAP_POLICY,
};
