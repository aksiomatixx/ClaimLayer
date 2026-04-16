'use strict';

/**
 * reportingService.js — M10 Reporting.
 *
 * Provides data for:
 *   - Employer loss run (all claims for an employer)
 *   - Employer summary (aggregate stats)
 *   - Experience mod inputs (payroll/losses by class code)
 *   - Admin cross-employer view
 *   - Missed deadline compliance report
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

// ── Home health WC class codes (CA) ─────────────────────────────────────────
// Mock payroll data by class code — real data will come from ADP in M_adp.
const MOCK_CLASS_CODES = {
  '8827': { description: 'Home Health Care — Professional Staff (RN/LVN)', rate: 2.41 },
  '8835': { description: 'Home Health Care — Home Health Aides',          rate: 4.93 },
  '8742': { description: 'Salespersons / Administrative / Clerical',      rate: 0.38 },
};

// ── Loss run ─────────────────────────────────────────────────────────────────

/**
 * Fetch all claims for a given employer, with reserve totals.
 * Returns an array of claim-level rows suitable for a loss run report.
 */
async function getLossRun(employerId) {
  const { data: claims, error } = await supabase
    .from('claims')
    .select('*, reserves(*), diaries(*)')
    .eq('employer_id', employerId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ msg: 'reportingService.getLossRun: query failed', err: error.message });
    throw new Error(error.message);
  }

  return (claims || []).map(_toLossRunRow);
}

function _toLossRunRow(row) {
  // Compute total incurred from reserves (latest approved set wins)
  const reserves = row.reserves || [];
  let totalMedical   = 0;
  let totalIndemnity = 0;
  let totalExpense   = 0;

  if (reserves.length > 0) {
    // Use the most recent reserve entry
    const latest = reserves.sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    )[0];
    totalMedical   = parseFloat(latest.medical   || 0);
    totalIndemnity = parseFloat(latest.indemnity  || 0);
    totalExpense   = parseFloat(latest.expense    || 0);
  } else if (row.ai_analysis) {
    // Fall back to AI-suggested reserves if no adjuster-approved reserves exist
    totalMedical   = row.ai_analysis.suggestedMedicalReserve   || 0;
    totalIndemnity = row.ai_analysis.suggestedIndemnityReserve || 0;
    totalExpense   = row.ai_analysis.suggestedExpenseReserve   || 0;
  }

  const totalIncurred = totalMedical + totalIndemnity + totalExpense;

  // Worker name from employee snapshot
  const emp = row.employee || {};
  const workerName = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Unknown';

  // TD weeks paid — count TD_PAYMENT_SETUP diaries that are completed
  const tdWeeks = (row.diaries || []).filter(
    d => d.diary_type === 'TD_PAYMENT_SETUP' && d.status === 'completed'
  ).length;

  return {
    claimNumber:    row.claim_number,
    claimId:        row.id,
    worker:         workerName,
    dateOfInjury:   row.date_of_injury,
    injuryType:     row.injury_type  || null,
    bodyPart:       row.body_part    || null,
    status:         row.status,
    medical:        totalMedical,
    indemnity:      totalIndemnity,
    expense:        totalExpense,
    totalIncurred,
    tdWeeksPaid:    tdWeeks,
    filedAt:        row.filed_at     || row.created_at,
    isOpen:         !['closed', 'denied'].includes(row.status),
  };
}

// ── Employer summary ─────────────────────────────────────────────────────────

/**
 * Aggregate stats for a single employer.
 */
async function getEmployerSummary(employerId) {
  const lossRun = await getLossRun(employerId);

  const now      = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const openClaims    = lossRun.filter(r => r.isOpen);
  const ytdClaims     = lossRun.filter(r => new Date(r.filedAt) >= yearStart);
  const totalIncurred = ytdClaims.reduce((s, r) => s + r.totalIncurred, 0);
  const tdWeeksYTD    = ytdClaims.reduce((s, r) => s + r.tdWeeksPaid, 0);

  // Average days to first payment — use diaries
  const { data: diaries, error: dErr } = await supabase
    .from('diaries')
    .select('claim_id, diary_type, status, due_date, created_at');

  // Build per-claim first-payment info
  const claimIds = new Set(lossRun.map(r => r.claimId));
  const tdDiaries = (diaries || []).filter(
    d => d.diary_type === 'TD_PAYMENT_SETUP' && claimIds.has(d.claim_id)
  );

  // For average days: compare claim filed_at to TD diary due_date
  let totalDays = 0;
  let countDays = 0;
  for (const r of lossRun) {
    const td = tdDiaries.find(d => d.claim_id === r.claimId);
    if (td && r.filedAt) {
      const filed = new Date(r.filedAt);
      const due   = new Date(td.due_date);
      const days  = Math.round((due - filed) / (1000 * 60 * 60 * 24));
      if (days >= 0) {
        totalDays += days;
        countDays++;
      }
    }
  }

  const avgDaysToFirstPayment = countDays > 0 ? Math.round(totalDays / countDays) : null;

  return {
    openClaimCount:        openClaims.length,
    totalClaimCount:       lossRun.length,
    totalIncurredYTD:      Math.round(totalIncurred * 100) / 100,
    tdWeeksPaidYTD:        tdWeeksYTD,
    avgDaysToFirstPayment,
  };
}

// ── Experience mod inputs ────────────────────────────────────────────────────

/**
 * Raw inputs needed for WCIRB experience modification calculation.
 * Real payroll data will come from ADP. For now, uses mock class code payroll.
 */
async function getExperienceModInputs(employerId) {
  const lossRun = await getLossRun(employerId);

  // Group losses by class code (using injury type as proxy until ADP provides real codes)
  const lossesByClass = {};
  for (const r of lossRun) {
    // Map job titles to class codes (simplified — real mapping from ADP)
    const classCode = _inferClassCode(r);
    if (!lossesByClass[classCode]) {
      lossesByClass[classCode] = {
        classCode,
        description: MOCK_CLASS_CODES[classCode]?.description || 'Unknown',
        rate:        MOCK_CLASS_CODES[classCode]?.rate || 0,
        claimCount:  0,
        totalLosses: 0,
        openClaims:  0,
      };
    }
    lossesByClass[classCode].claimCount++;
    lossesByClass[classCode].totalLosses += r.totalIncurred;
    if (r.isOpen) lossesByClass[classCode].openClaims++;
  }

  // Mock payroll by class code (from ADP in production)
  const payrollByClass = Object.keys(MOCK_CLASS_CODES).map(code => ({
    classCode:   code,
    description: MOCK_CLASS_CODES[code].description,
    rate:        MOCK_CLASS_CODES[code].rate,
    annualPayroll: code === '8835' ? 1_200_000 : code === '8827' ? 800_000 : 350_000,
    premium:     0, // Calculated below
  }));

  for (const p of payrollByClass) {
    p.premium = Math.round(p.annualPayroll * p.rate / 100);
  }

  // Experience period — WCIRB uses 3 policy years, 1 year lag
  const currentYear = new Date().getFullYear();
  const experiencePeriod = {
    start: currentYear - 4,
    end:   currentYear - 1,
    label: `${currentYear - 4}–${currentYear - 1}`,
  };

  // Year-over-year loss trend (for chart)
  const trendData = [];
  for (let y = currentYear - 4; y <= currentYear; y++) {
    const yearClaims = lossRun.filter(r => {
      const doi = new Date(r.dateOfInjury);
      return doi.getFullYear() === y;
    });
    trendData.push({
      year:         y,
      claimCount:   yearClaims.length,
      totalLosses:  Math.round(yearClaims.reduce((s, r) => s + r.totalIncurred, 0) * 100) / 100,
      openClaims:   yearClaims.filter(r => r.isOpen).length,
    });
  }

  return {
    employerId,
    experiencePeriod,
    payrollByClass,
    lossesByClass: Object.values(lossesByClass),
    trendData,
    totalPayroll:  payrollByClass.reduce((s, p) => s + p.annualPayroll, 0),
    totalPremium:  payrollByClass.reduce((s, p) => s + p.premium, 0),
    totalLosses:   lossRun.reduce((s, r) => s + r.totalIncurred, 0),
    totalClaims:   lossRun.length,
  };
}

/**
 * Infer WC class code from claim data.
 * Simplified — real implementation uses ADP job classification.
 */
function _inferClassCode(lossRunRow) {
  const worker = (lossRunRow.worker || '').toLowerCase();
  if (worker.includes('rn') || worker.includes('lvn') || worker.includes('nurse')) return '8827';
  if (worker.includes('admin') || worker.includes('clerk') || worker.includes('office')) return '8742';
  return '8835'; // Default: Home Health Aide
}

// ── Admin: cross-employer report ─────────────────────────────────────────────

/**
 * Admin-only: aggregated stats across all employers.
 */
async function getCrossEmployerReport() {
  const { data: claims, error } = await supabase
    .from('claims')
    .select('*, reserves(*)');

  if (error) {
    logger.error({ msg: 'reportingService.getCrossEmployerReport: query failed', err: error.message });
    throw new Error(error.message);
  }

  // Group by employer
  const byEmployer = {};
  for (const c of (claims || [])) {
    const eid = c.employer_id || 'unknown';
    if (!byEmployer[eid]) {
      byEmployer[eid] = {
        employerId:   eid,
        employerName: c.employer_name || eid,
        totalClaims:  0,
        openClaims:   0,
        totalIncurred: 0,
      };
    }

    byEmployer[eid].totalClaims++;
    if (!['closed', 'denied'].includes(c.status)) {
      byEmployer[eid].openClaims++;
    }

    // Incurred from reserves or AI
    const reserves = c.reserves || [];
    if (reserves.length > 0) {
      const latest = reserves.sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
      )[0];
      byEmployer[eid].totalIncurred += parseFloat(latest.medical || 0)
        + parseFloat(latest.indemnity || 0)
        + parseFloat(latest.expense || 0);
    } else if (c.ai_analysis) {
      byEmployer[eid].totalIncurred +=
        (c.ai_analysis.suggestedMedicalReserve   || 0) +
        (c.ai_analysis.suggestedIndemnityReserve || 0) +
        (c.ai_analysis.suggestedExpenseReserve   || 0);
    }
  }

  const employers = Object.values(byEmployer)
    .sort((a, b) => b.totalIncurred - a.totalIncurred);

  return {
    employers,
    totalOpenClaims:  employers.reduce((s, e) => s + e.openClaims, 0),
    totalAllClaims:   employers.reduce((s, e) => s + e.totalClaims, 0),
    totalIncurred:    Math.round(employers.reduce((s, e) => s + e.totalIncurred, 0) * 100) / 100,
  };
}

// ── Admin: missed deadline report ────────────────────────────────────────────

/**
 * Admin-only: claims with missed statutory deadlines.
 *
 * Checks:
 *   - TD first payment >14 days from filed_at (LC §4650)
 *   - DWC-7 notice >5 days from filed_at
 *   - RFA clock expired (response_due_at passed without decision)
 */
async function getMissedDeadlineReport() {
  const now = new Date();
  const violations = [];

  // 1. TD payment deadline — claims filed >14 days ago with open TD diary
  const { data: claims } = await supabase
    .from('claims')
    .select('*, diaries(*)');

  for (const c of (claims || [])) {
    if (!c.filed_at) continue;
    const filed = new Date(c.filed_at);
    const daysSinceFiled = Math.round((now - filed) / (1000 * 60 * 60 * 24));

    // TD first payment check — 14 calendar days
    const tdDiary = (c.diaries || []).find(d => d.diary_type === 'TD_PAYMENT_SETUP');
    if (tdDiary && tdDiary.status === 'open' && daysSinceFiled > 14) {
      violations.push({
        claimId:      c.id,
        claimNumber:  c.claim_number,
        employerId:   c.employer_id,
        employerName: c.employer_name,
        worker:       _workerName(c),
        type:         'TD_LATE',
        description:  'TD first payment overdue — LC §4650 (14-day deadline)',
        daysOverdue:  daysSinceFiled - 14,
        dueDate:      tdDiary.due_date,
        penalty:      '10% self-imposed increase per LC §4650(d)',
      });
    }

    // DWC-7 notice check — 5 calendar days
    const dwc7Diary = (c.diaries || []).find(d => d.diary_type === 'DWC7_NOTICE');
    if (dwc7Diary && dwc7Diary.status === 'open' && daysSinceFiled > 5) {
      violations.push({
        claimId:      c.id,
        claimNumber:  c.claim_number,
        employerId:   c.employer_id,
        employerName: c.employer_name,
        worker:       _workerName(c),
        type:         'DWC7_LATE',
        description:  'DWC-7 notice not sent — due within 5 days of claim receipt',
        daysOverdue:  daysSinceFiled - 5,
        dueDate:      dwc7Diary.due_date,
        penalty:      'DWC audit finding — administrative penalty exposure',
      });
    }
  }

  // 2. RFA clock expired — rfas with response_due_at < now and no decision
  const { data: rfas } = await supabase
    .from('rfas')
    .select('*');

  for (const rfa of (rfas || [])) {
    if (!rfa.response_due_at) continue;
    const dueAt = new Date(rfa.response_due_at);
    if (dueAt < now && (!rfa.decision || rfa.decision === 'pending' || rfa.decision === 'pending_adjuster_review')) {
      const daysOverdue = Math.round((now - dueAt) / (1000 * 60 * 60 * 24));
      violations.push({
        claimId:      rfa.claim_id,
        claimNumber:  rfa.claim_number || null,
        employerId:   null,
        employerName: null,
        worker:       null,
        type:         'RFA_EXPIRED',
        description:  'RFA clock expired — deemed approved by operation of law',
        daysOverdue,
        dueDate:      rfa.response_due_at,
        penalty:      'Treatment deemed authorized — LC §4610(i)',
      });
    }
  }

  return {
    violations: violations.sort((a, b) => b.daysOverdue - a.daysOverdue),
    totalViolations: violations.length,
    byType: {
      TD_LATE:     violations.filter(v => v.type === 'TD_LATE').length,
      DWC7_LATE:   violations.filter(v => v.type === 'DWC7_LATE').length,
      RFA_EXPIRED: violations.filter(v => v.type === 'RFA_EXPIRED').length,
    },
  };
}

function _workerName(claimRow) {
  const emp = claimRow.employee || {};
  return [emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Unknown';
}

module.exports = {
  getLossRun,
  getEmployerSummary,
  getExperienceModInputs,
  getCrossEmployerReport,
  getMissedDeadlineReport,
};
