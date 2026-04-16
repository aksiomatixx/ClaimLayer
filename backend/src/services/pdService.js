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
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// initiatePDAdvances
// ═════════════════════════════════════════════════════════════════════════════
async function initiatePDAdvances(claimId, pdEvaluationId, { tdEndDate }) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// recordPDAdvancePayment
// ═════════════════════════════════════════════════════════════════════════════
async function recordPDAdvancePayment(pdAdvanceId) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// waivePDAdvance
// ═════════════════════════════════════════════════════════════════════════════
async function waivePDAdvance(pdAdvanceId, adjusterId, reason) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// createStipulation
// ═════════════════════════════════════════════════════════════════════════════
async function createStipulation(claimId, pdEvaluationId, { futureMedical, futureMedicalDesc, bodyPartsAccepted }) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// sendStipToWorker
// ═════════════════════════════════════════════════════════════════════════════
async function sendStipToWorker(stipId) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// recordWorkerSignature
// ═════════════════════════════════════════════════════════════════════════════
async function recordWorkerSignature(stipId) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// recordAdjusterSignature
// ═════════════════════════════════════════════════════════════════════════════
async function recordAdjusterSignature(stipId, adjusterId) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// recordEAMSFiled
// ═════════════════════════════════════════════════════════════════════════════
async function recordEAMSFiled(stipId, { filedDate }) {
  // stub
}

// ═════════════════════════════════════════════════════════════════════════════
// Read operations
// ═════════════════════════════════════════════════════════════════════════════
async function getPDEvaluation(claimId) {
  // stub
}

async function getStipulation(claimId) {
  // stub
}

async function getPDAdvances(claimId) {
  // stub
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
  // Exported for tests
  _computePDWeeklyRate,
  _addCalendarDays,
  PD_RATES_2026,
};
