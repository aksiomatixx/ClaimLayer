'use strict';

/**
 * Carrier & Policy Modeling (Tier 1).
 *
 * First-class insurers and policies, superseding the M22A-prebuild
 * "Option A" minimal modeling (single insurer per employer row). The
 * employer-row insurer fields remain the fallback for claims with no
 * resolved policy, so existing books keep working.
 *
 * Resolution rule: the policy in force for a claim is the one whose
 * [effective_date, expiration_date] interval contains the date of
 * injury. Open-ended policies (expiration_date NULL) match any DOI on
 * or after the effective date. If several match (data-entry overlap),
 * the most recently effective wins, and we log a warning — overlapping
 * policies are a data problem the carrier needs to resolve.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

function _id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const FEIN_RE = /^[0-9]{9}$/;

// ── Insurers ──────────────────────────────────────────────────────────────────

async function createInsurer({ fein, name, naic_code, address }) {
  if (!FEIN_RE.test(String(fein || ''))) throw new Error('fein must be 9 digits');
  if (!name) throw new Error('name is required');

  const row = {
    id: _id('ins'),
    fein: String(fein),
    name,
    naic_code: naic_code || null,
    address: address || null,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('insurers').insert(row).select().single();
  if (error) throw new Error(`policyService.createInsurer: ${error.message}`);
  return data;
}

async function listInsurers() {
  const { data, error } = await supabase.from('insurers').select('*');
  if (error) throw new Error(`policyService.listInsurers: ${error.message}`);
  return (data || []).sort((a, b) => a.name.localeCompare(b.name));
}

async function getInsurer(id) {
  const { data } = await supabase.from('insurers').select('*').eq('id', id).single();
  return data || null;
}

// ── Policies ──────────────────────────────────────────────────────────────────

async function createPolicy({
  employer_id, insurer_id, policy_number, effective_date, expiration_date, self_insured,
}) {
  if (!employer_id) throw new Error('employer_id is required');
  if (!policy_number) throw new Error('policy_number is required');
  if (!effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) {
    throw new Error('effective_date must be YYYY-MM-DD');
  }
  if (expiration_date && expiration_date < effective_date) {
    throw new Error('expiration_date must be on or after effective_date');
  }
  const selfInsured = !!self_insured;
  if (!selfInsured && !insurer_id) {
    throw new Error('insurer_id is required unless the policy is self-insured');
  }
  if (!selfInsured) {
    const insurer = await getInsurer(insurer_id);
    if (!insurer) throw new Error(`Insurer not found: ${insurer_id}`);
  }
  const { data: employer } = await supabase
    .from('employers').select('id').eq('id', employer_id).single();
  if (!employer) throw new Error(`Employer not found: ${employer_id}`);

  const row = {
    id: _id('pol'),
    employer_id,
    insurer_id: selfInsured ? null : insurer_id,
    policy_number,
    effective_date,
    expiration_date: expiration_date || null,
    self_insured: selfInsured,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('policies').insert(row).select().single();
  if (error) throw new Error(`policyService.createPolicy: ${error.message}`);
  return data;
}

async function listPoliciesForEmployer(employerId) {
  const { data, error } = await supabase
    .from('policies').select('*').eq('employer_id', employerId);
  if (error) throw new Error(`policyService.listPoliciesForEmployer: ${error.message}`);
  return (data || []).sort((a, b) =>
    String(b.effective_date).localeCompare(String(a.effective_date)));
}

/**
 * Resolve the policy in force for an employer on a given date of injury.
 * Returns the policy row or null. Never throws on "no match" — claims
 * without a resolvable policy fall back to employer-row insurer data.
 */
async function resolvePolicy(employerId, dateOfInjury) {
  if (!employerId || !dateOfInjury) return null;
  const doi = String(dateOfInjury).split('T')[0];

  const policies = await listPoliciesForEmployer(employerId);
  const matches = policies.filter(p =>
    p.effective_date <= doi && (p.expiration_date == null || doi <= p.expiration_date));

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    logger.warn({
      msg: 'policyService.resolvePolicy: overlapping policies — using most recent effective',
      employerId, doi, matched: matches.map(p => p.id),
    });
  }
  // listPoliciesForEmployer sorts most-recent-effective first.
  return matches[0];
}

/**
 * Insurer context for WCIS payloads: given a claim row, return
 * { insurer_fein, claim_administrator_fein, source } preferring the
 * resolved policy over the employer-row fallback.
 */
async function insurerContextForClaim(claim) {
  if (claim.policy_id) {
    const { data: policy } = await supabase
      .from('policies').select('*').eq('id', claim.policy_id).single();
    if (policy) {
      if (policy.self_insured) {
        const { data: employer } = await supabase
          .from('employers').select('fein').eq('id', claim.employer_id).single();
        return {
          insurer_fein: employer?.fein || null,
          claim_administrator_fein: employer?.fein || null,
          source: 'policy_self_insured',
        };
      }
      const insurer = await getInsurer(policy.insurer_id);
      if (insurer) {
        return {
          insurer_fein: insurer.fein,
          claim_administrator_fein: null, // TPA FEIN comes from env/claim override
          source: 'policy',
        };
      }
    }
  }
  return null; // caller falls back to employer-row data
}

module.exports = {
  createInsurer,
  listInsurers,
  getInsurer,
  createPolicy,
  listPoliciesForEmployer,
  resolvePolicy,
  insurerContextForClaim,
};
