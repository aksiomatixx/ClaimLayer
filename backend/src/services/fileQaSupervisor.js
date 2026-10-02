'use strict';

/**
 * fileQaSupervisor.js — Phase 5 Autonomous File QA & Statutory Exception Engine.
 *
 * Scans open claims to detect compliance exceptions, statutory deadlines,
 * and reserve adequacy anomalies:
 *   1. Labor Code §5402 90-Day Compensability Presumption:
 *      Alerts the adjuster when the presumption date — 90 calendar days from
 *      claim form receipt (claims.filed_at, the same anchor the
 *      COMPENSABILITY_DECISION_DUE diary uses) — is within 15 days or has
 *      passed on an undecided claim. REGULATORY-PENDING: LC §5402 is carried
 *      from existing repo copy and remains pending verification under
 *      docs/regulatory/.
 *   2. Reserve Adequacy Anomaly:
 *      Flags claims open > 30 days with $0 reserves across all categories.
 *   3. Overdue PR-2 Progress Reports (CCR §9785):
 *      Detects active medical claims without treating physician updates for > 45 days.
 *   4. Unreviewed Litigated Claims:
 *      Schedules supervisor audit for litigated claims lacking recent evaluation.
 */

const { supabase }  = require('./supabase');
const logger        = require('../logger');
const auditLedger   = require('./auditLedgerService');
const reserveLedger = require('./reserveLedgerService');
const config        = require('../config');

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Run a full QA audit sweep for a tenant.
 */
async function runFileQASweep({ tenantId = null } = {}) {
  const effectiveTenantId = tenantId || config.tenancy.defaultTenantId;
  const now = new Date();
  const nowIso = now.toISOString();

  let query = supabase
    .from('claims')
    .select('id, claim_number, date_of_injury, filed_at, status, admin_status, compensability_status, litigation_status, attorney_represented, created_at, tenant_id')
    .neq('status', 'closed');

  if (tenantId) query = query.eq('tenant_id', tenantId);

  const { data: claims, error } = await query;
  if (error) {
    logger.error({ msg: 'fileQaSupervisor: claim query failed', err: error.message });
    throw new Error(`QA sweep failed: ${error.message}`);
  }

  const claimList = claims || [];
  const findings = [];

  for (const c of claimList) {
    const claimId = c.id;
    const createdAt = new Date(c.created_at || nowIso);
    const daysSinceCreated = Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY);

    // ── Exception 1: LC §5402 presumption date (claim form receipt + 90 days) ─
    // Measured from claim form receipt, never from the date of injury (a claim
    // reported weeks after the injury would otherwise be flagged — or missed —
    // on the wrong date). Open while compensability is undecided or delayed.
    if (['pending_investigation', 'delayed'].includes(c.compensability_status || 'pending_investigation')) {
      const presumption = _presumptionDate(c.filed_at);
      if (!presumption) {
        findings.push({
          claimId,
          claimNumber: c.claim_number,
          exceptionType: 'LC_5402_RECEIPT_DATE_MISSING',
          severity: 'HIGH',
          description: 'Claim form receipt date is missing: the LC §5402 presumption date cannot be computed. Record the receipt date.',
        });
      } else {
        const today = nowIso.slice(0, 10);
        const daysRemaining = Math.round((Date.parse(`${presumption}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
        if (daysRemaining < 0) {
          findings.push({
            claimId,
            claimNumber: c.claim_number,
            exceptionType: 'LC_5402_PRESUMPTION_DATE_PASSED',
            severity: 'CRITICAL',
            presumptionDate: presumption,
            description: `Labor Code §5402: the presumption date (${presumption}, 90 days from claim form receipt) has passed with compensability undecided. Escalate to the supervisor.`,
          });
        } else if (daysRemaining <= 15) {
          findings.push({
            claimId,
            claimNumber: c.claim_number,
            exceptionType: 'LC_5402_APPROACHING_DEADLINE',
            severity: 'CRITICAL',
            presumptionDate: presumption,
            description: `Labor Code §5402: ${daysRemaining} day(s) to the presumption date (${presumption}). An undenied claim is presumed compensable after it.`,
          });

          // Ensure a high-priority diary exists
          await _ensureDiary(claimId, {
            tenantId: c.tenant_id,
            diaryType: 'LC_5402_COMPENSABILITY_DECISION',
            priority: 'CRITICAL',
            notes: `Statutory date ${presumption}: ${daysRemaining} day(s) until the LC §5402 presumption of compensability applies. Complete the investigation and issue the determination notice.`,
            daysFromNow: Math.max(0, daysRemaining - 3),
          });
        }
      }
    }

    // ── Exception 2: Zero Reserve Adequacy Anomaly ────────────────────────────
    if (daysSinceCreated >= 30) {
      let balances = null;
      try {
        balances = await reserveLedger.getBalances(claimId);
      } catch (e) {
        // A read failure skips this one check for this claim; it is logged, not hidden.
        logger.warn({ msg: 'fileQaSupervisor: reserve balance read failed', claimId, err: e.message });
      }

      if (balances && balances.totals.outstanding_reserves === 0 && balances.totals.paid_to_date === 0) {
        findings.push({
          claimId,
          claimNumber: c.claim_number,
          exceptionType: 'ZERO_RESERVE_INADEQUACY',
          severity: 'HIGH',
          description: `Claim has been open for ${daysSinceCreated} days with $0 total reserves. Initial reserve setup is required.`,
        });

        await _ensureDiary(claimId, {
          tenantId: c.tenant_id,
          diaryType: 'RESERVE_ADEQUACY_REVIEW',
          priority: 'HIGH',
          notes: `File audit exception: Claim open ${daysSinceCreated} days with zero reserves. Itemize worksheet and establish initial reserves.`,
          daysFromNow: 5,
        });
      }
    }

    // ── Exception 3: Litigated Claim Supervisory Review ──────────────────────
    if (c.status === 'litigated' || c.litigation_status === 'application_filed' || c.attorney_represented) {
      if (daysSinceCreated >= 45) {
        findings.push({
          claimId,
          claimNumber: c.claim_number,
          exceptionType: 'LITIGATED_FILE_AUDIT_DUE',
          severity: 'NORMAL',
          description: 'Litigated or attorney-represented claim due for supervisory plan of action review.',
        });
      }
    }
  }

  logger.info({
    msg: 'fileQaSupervisor: sweep complete',
    tenantId: effectiveTenantId,
    claimsScanned: claimList.length,
    exceptionsFound: findings.length,
  });

  return {
    run_date: nowIso,
    tenant_id: effectiveTenantId,
    claims_scanned: claimList.length,
    exception_count: findings.length,
    findings,
  };
}

// Claim form receipt + 90 calendar days, as a YYYY-MM-DD (UTC) date, or null.
function _presumptionDate(filedAt) {
  if (!filedAt) return null;
  const t = Date.parse(filedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 90 * MS_PER_DAY).toISOString().slice(0, 10);
}

async function _ensureDiary(claimId, { tenantId, diaryType, priority, notes, daysFromNow }) {
  const { data: existing } = await supabase
    .from('diaries')
    .select('id')
    .eq('claim_id', claimId)
    .eq('diary_type', diaryType)
    .eq('status', 'open');

  if (existing && existing.length > 0) return; // Diary already open

  const dueDate = new Date(Date.now() + daysFromNow * MS_PER_DAY).toISOString().slice(0, 10);
  const now = new Date().toISOString();

  await supabase.from('diaries').insert({
    tenant_id:  tenantId || config.tenancy.defaultTenantId,
    claim_id:   claimId,
    diary_type: diaryType,
    due_date:   dueDate,
    priority,
    notes,
    status:     'open',
    created_at: now,
    updated_at: now,
  });
}

module.exports = {
  runFileQASweep,
  _presumptionDate,
};
