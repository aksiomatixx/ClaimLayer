'use strict';

/**
 * staffingService.js — Phase 2 Staffing Hierarchy & Client Loss-Run Analytics.
 *
 * Implements the true staffing industry relationship model:
 *   Staffing Agency -> Host Employer (Client) -> Client Assignment -> Injured Worker -> Claim
 *
 * Capabilities:
 *   1. Agency & Host Employer Management: Multi-client staffing portfolio model.
 *   2. Client Assignment Tracking: Worker placement, class codes, and wages.
 *   3. Client Loss Runs: Authoritative financial & injury aggregations per host employer client.
 *   4. Granular Body Part Compensability: Per-body-part acceptance, delay, or denial tracking.
 */

const crypto        = require('crypto');
const { supabase }  = require('./supabase');
const logger        = require('../logger');
const auditLedger   = require('./auditLedgerService');
const reserveLedger = require('./reserveLedgerService');
const config        = require('../config');

const _round2 = (n) => Math.round(Number(n) * 100) / 100;

// ── 1. Staffing Agencies ──────────────────────────────────────────────────────

async function createAgency(input, opts = {}) {
  const { tenantId, name, fein, licenseNumber, contactEmail } = input || {};
  if (!name) throw new Error('Agency name is required');

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const row = {
    id,
    tenant_id:      effectiveTenantId,
    name:           String(name).trim(),
    fein:           fein || null,
    license_number: licenseNumber || null,
    contact_email:  contactEmail || null,
    status:         'active',
    created_at:     now,
    updated_at:     now,
  };

  const { data, error } = await supabase.from('staffing_agencies').insert(row).select().single();
  if (error) throw new Error(`createAgency failed: ${error.message}`);
  return data || row;
}

async function getAgency(agencyId) {
  const { data, error } = await supabase.from('staffing_agencies').select('*').eq('id', agencyId).single();
  if (error || !data) return null;
  return data;
}

async function listAgencies(filters = {}) {
  let query = supabase.from('staffing_agencies').select('*').order('name', { ascending: true });
  if (filters.tenantId) query = query.eq('tenant_id', filters.tenantId);
  if (filters.status)   query = query.eq('status', filters.status);
  const { data, error } = await query;
  if (error) throw new Error(`listAgencies failed: ${error.message}`);
  return data || [];
}

// ── 2. Host Employers (Clients) ───────────────────────────────────────────────

async function createHostEmployer(input, opts = {}) {
  const { tenantId, agencyId, name, industryNaics, worksiteAddress, city, state, zipCode } = input || {};
  if (!agencyId) throw new Error('agencyId is required');
  if (!name) throw new Error('Host employer name is required');

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const row = {
    id,
    tenant_id:        effectiveTenantId,
    agency_id:        agencyId,
    name:             String(name).trim(),
    industry_naics:   industryNaics || null,
    worksite_address: worksiteAddress || null,
    city:             city || null,
    state:            state || null,
    zip_code:         zipCode || null,
    status:           'active',
    created_at:       now,
    updated_at:       now,
  };

  const { data, error } = await supabase.from('host_employers').insert(row).select().single();
  if (error) throw new Error(`createHostEmployer failed: ${error.message}`);
  return data || row;
}

async function getHostEmployer(hostEmployerId) {
  const { data, error } = await supabase.from('host_employers').select('*, staffing_agencies(name)').eq('id', hostEmployerId).single();
  if (error || !data) return null;
  return data;
}

async function listHostEmployers(filters = {}) {
  let query = supabase.from('host_employers').select('*, staffing_agencies(name)').order('name', { ascending: true });
  if (filters.tenantId) query = query.eq('tenant_id', filters.tenantId);
  if (filters.agencyId) query = query.eq('agency_id', filters.agencyId);
  if (filters.status)   query = query.eq('status', filters.status);
  const { data, error } = await query;
  if (error) throw new Error(`listHostEmployers failed: ${error.message}`);
  return data || [];
}

// ── 3. Client Assignments ─────────────────────────────────────────────────────

async function createAssignment(input, opts = {}) {
  const {
    tenantId,
    agencyId,
    hostEmployerId,
    employeeId,
    jobTitle,
    classCode,
    hourlyWage,
    startDate,
    endDate,
  } = input || {};

  if (!agencyId)       throw new Error('agencyId is required');
  if (!hostEmployerId) throw new Error('hostEmployerId is required');
  if (!employeeId)     throw new Error('employeeId is required');
  if (!startDate)      throw new Error('startDate is required');

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const row = {
    id,
    tenant_id:        effectiveTenantId,
    agency_id:        agencyId,
    host_employer_id: hostEmployerId,
    employee_id:      employeeId,
    job_title:        jobTitle || null,
    class_code:       classCode || null,
    hourly_wage:      hourlyWage != null ? _round2(hourlyWage) : null,
    start_date:       startDate,
    end_date:         endDate || null,
    status:           'active',
    created_at:       now,
    updated_at:       now,
  };

  const { data, error } = await supabase.from('client_assignments').insert(row).select().single();
  if (error) throw new Error(`createAssignment failed: ${error.message}`);
  return data || row;
}

async function getAssignment(assignmentId) {
  const { data, error } = await supabase
    .from('client_assignments')
    .select('*, host_employers(name), staffing_agencies(name), employees(first_name, last_name)')
    .eq('id', assignmentId)
    .single();

  if (error || !data) return null;
  return data;
}

// ── 4. Client Loss Runs ───────────────────────────────────────────────────────

/**
 * Generate a comprehensive client loss run for a host employer.
 */
async function getClientLossRun({ hostEmployerId, startDate = null, endDate = null, tenantId = null }) {
  if (!hostEmployerId) throw new Error('hostEmployerId is required');

  const hostEmployer = await getHostEmployer(hostEmployerId);
  if (!hostEmployer || (tenantId && hostEmployer.tenant_id !== tenantId)) {
    throw new Error(`Host employer not found: ${hostEmployerId}`);
  }

  let query = supabase
    .from('claims')
    .select('id, claim_number, date_of_injury, status, admin_status, compensability_status, litigation_status, body_part, injury_type, employee, aww, td_rate, created_at')
    .eq('host_employer_id', hostEmployerId);

  if (tenantId)  query = query.eq('tenant_id', tenantId);
  if (startDate) query = query.gte('date_of_injury', startDate);
  if (endDate)   query = query.lte('date_of_injury', endDate);

  const { data: claims, error } = await query.order('date_of_injury', { ascending: false });
  if (error) throw new Error(`getClientLossRun query failed: ${error.message}`);

  const claimList = claims || [];
  let totalPaid = 0;
  let totalOutstanding = 0;
  let totalIncurred = 0;

  const enrichedClaims = [];
  const injuryTypeCounts = {};
  const bodyPartCounts = {};

  for (const c of claimList) {
    let balances = {
      totals: { paid_to_date: 0, outstanding_reserves: 0, total_incurred: 0 },
      categories: {
        medical: { outstanding: 0, paid: 0 },
        indemnity: { outstanding: 0, paid: 0 },
        expense: { outstanding: 0, paid: 0 },
      },
    };

    try {
      balances = await reserveLedger.getBalances(c.id);
    } catch (e) {
      // Non-fatal
    }

    const claimPaid = balances.totals.paid_to_date;
    const claimReserves = balances.totals.outstanding_reserves;
    const claimIncurred = balances.totals.total_incurred;

    totalPaid = _round2(totalPaid + claimPaid);
    totalOutstanding = _round2(totalOutstanding + claimReserves);
    totalIncurred = _round2(totalIncurred + claimIncurred);

    const itype = c.injury_type || 'Unknown';
    injuryTypeCounts[itype] = (injuryTypeCounts[itype] || 0) + 1;

    const bpart = c.body_part || 'Unknown';
    bodyPartCounts[bpart] = (bodyPartCounts[bpart] || 0) + 1;

    enrichedClaims.push({
      claim_id:              c.id,
      claim_number:          c.claim_number,
      worker_name:           c.employee ? `${c.employee.firstName || ''} ${c.employee.lastName || ''}`.trim() : 'Unknown',
      date_of_injury:        c.date_of_injury,
      admin_status:          c.admin_status || 'open',
      compensability_status: c.compensability_status || 'pending_investigation',
      litigation_status:     c.litigation_status || 'unrepresented',
      injury_type:           c.injury_type,
      body_part:             c.body_part,
      paid_to_date:          claimPaid,
      outstanding_reserves:  claimReserves,
      total_incurred:        claimIncurred,
    });
  }

  const openCount      = claimList.filter(c => (c.admin_status || 'open') === 'open').length;
  const closedCount    = claimList.filter(c => (c.admin_status || '') === 'closed').length;
  const litigatedCount = claimList.filter(c => ['represented', 'application_filed', 'in_settlement', 'awarded'].includes(c.litigation_status)).length;

  return {
    host_employer: {
      id:       hostEmployer.id,
      name:     hostEmployer.name,
      agency:   hostEmployer.staffing_agencies?.name || null,
      industry: hostEmployer.industry_naics,
    },
    run_date: new Date().toISOString(),
    filter_period: { start: startDate, end: endDate },
    summary: {
      total_claims:         claimList.length,
      open_claims:          openCount,
      closed_claims:        closedCount,
      litigated_claims:     litigatedCount,
      total_paid:           totalPaid,
      total_reserves:       totalOutstanding,
      total_incurred:       totalIncurred,
      average_claim_cost:   claimList.length ? _round2(totalIncurred / claimList.length) : 0,
      litigation_rate_pct:  claimList.length ? _round2((litigatedCount / claimList.length) * 100) : 0,
    },
    distribution: {
      by_injury_type: injuryTypeCounts,
      by_body_part:   bodyPartCounts,
    },
    claims: enrichedClaims,
  };
}

// ── 5. Granular Body Part Compensability ───────────────────────────────────────

async function addClaimBodyPart({ tenantId, claimId, bodyPartCode, bodyPartName, side = null }, opts = {}) {
  if (!claimId) throw new Error('claimId is required');
  if (!bodyPartCode) throw new Error('bodyPartCode is required');
  if (!bodyPartName) throw new Error('bodyPartName is required');

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const row = {
    id,
    tenant_id:             effectiveTenantId,
    claim_id:              claimId,
    body_part_code:        bodyPartCode,
    body_part_name:        bodyPartName,
    side:                  side || null,
    compensability_status: 'pending_investigation',
    created_at:            now,
    updated_at:            now,
  };

  const { data, error } = await supabase.from('claim_body_parts').insert(row).select().single();
  if (error) throw new Error(`addClaimBodyPart failed: ${error.message}`);
  return data || row;
}

async function updateBodyPartCompensability(bodyPartId, status, { reason, actor } = {}, opts = {}) {
  if (!['accepted', 'delayed', 'denied', 'pending_investigation'].includes(status)) {
    throw new Error(`Invalid compensability status: ${status}`);
  }

  const now = new Date().toISOString();
  const patch = {
    compensability_status: status,
    updated_at:            now,
  };
  if (status === 'accepted') patch.accepted_at = now;
  if (status === 'delayed')  patch.delayed_at  = now;
  if (status === 'denied') {
    patch.denied_at = now;
    patch.denial_reason = reason || null;
  }

  const { data, error } = await supabase
    .from('claim_body_parts')
    .update(patch)
    .eq('id', bodyPartId)
    .select()
    .single();

  if (error) throw new Error(`updateBodyPartCompensability failed: ${error.message}`);

  if (data) {
    await auditLedger.append({
      actor: { type: 'human', id: actor?.id || 'adjuster', role: 'adjuster' },
      action: `body_part.compensability_${status}`,
      entity: { type: 'body_part', id: bodyPartId },
      claimId: data.claim_id,
      tenantId: data.tenant_id,
      payload: { status, reason, body_part_code: data.body_part_code },
    });
  }

  return data;
}

module.exports = {
  createAgency,
  getAgency,
  listAgencies,
  createHostEmployer,
  getHostEmployer,
  listHostEmployers,
  createAssignment,
  getAssignment,
  getClientLossRun,
  addClaimBodyPart,
  updateBodyPartCompensability,
};
