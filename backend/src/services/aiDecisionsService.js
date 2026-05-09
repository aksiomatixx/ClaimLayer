'use strict';

/**
 * aiDecisionsService.js — first-class audit log for every Claude
 * call (and deterministic gate decisions like MSA screening).
 *
 * Powers the admin "Agents" view: a filterable feed of every model
 * decision with input snapshot, parsed output, token / latency
 * stats, guardrail outcomes, and human override links.
 *
 * logDecision() never throws — logging failures are warnings; the
 * caller's AI return value is unchanged regardless.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

// ── logDecision ───────────────────────────────────────────────────────────────

async function logDecision(input) {
  const row = {
    claim_id:          input.claim_id || null,
    decision_type:     input.decision_type,
    prompt_name:       input.prompt_name,
    model:             input.model || 'unknown',
    input_snapshot:    input.input_snapshot || {},
    output_parsed:     input.output_parsed || null,
    output_raw:        input.output_raw    || null,
    input_tokens:      input.input_tokens  ?? null,
    output_tokens:     input.output_tokens ?? null,
    latency_ms:        input.latency_ms    ?? null,
    confidence:        input.confidence    ?? null,
    guardrail_actions: Array.isArray(input.guardrail_actions) ? input.guardrail_actions : [],
    created_at:        new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from('ai_decisions')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  } catch (err) {
    logger.warn({ msg: 'aiDecisionsService.logDecision: insert failed (non-fatal)', err: err.message, decision_type: row.decision_type });
    return null;
  }
}

// ── linkHumanDecision ─────────────────────────────────────────────────────────
//
// Update the most-recent ai_decisions row for (claim, type) with the
// adjuster's review action. Within last 7 days only — older rows
// represent stale decisions and shouldn't get retroactive overrides.
// Audit-logs an orphan note if no row matches.
//
async function linkHumanDecision(claimId, decisionType, fields) {
  if (!claimId || !decisionType) return null;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows } = await supabase
    .from('ai_decisions')
    .select('*')
    .eq('claim_id',      claimId)
    .eq('decision_type', decisionType)
    .order('created_at', { ascending: false });

  const recent = (rows || []).find(r => r.created_at >= cutoff);

  if (!recent) {
    try {
      await supabase.from('audit_log').insert({
        action:        'ai_decision_link_orphan',
        resource_type: 'ai_decisions',
        resource_id:   null,
        description:   `No recent ai_decisions row to link for ${decisionType} on ${claimId}`,
        new_value:     { claim_id: claimId, decision_type: decisionType, ...fields },
        user_role:     'admin',
        created_at:    new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
    return null;
  }

  const update = {
    human_reviewer_id: fields.human_reviewer_id || null,
    human_decision:    fields.human_decision || null,
    human_decision_at: new Date().toISOString(),
  };
  const { data: updated } = await supabase
    .from('ai_decisions').update(update).eq('id', recent.id).select().single();
  return updated || null;
}

// ── List + filter ─────────────────────────────────────────────────────────────

async function listDecisions(opts = {}) {
  const { claimId, decision_type, dateFrom, dateTo,
          hasOverride, guardrailTriggered, limit = 50, offset = 0 } = opts;

  let q = supabase.from('ai_decisions').select('*').order('created_at', { ascending: false });
  if (claimId)       q = q.eq('claim_id', claimId);
  if (decision_type) q = q.eq('decision_type', decision_type);

  const { data: rows = [], error } = await q;
  if (error) throw new Error(error.message);

  let filtered = rows;
  if (dateFrom)  filtered = filtered.filter(r => r.created_at >= dateFrom);
  if (dateTo)    filtered = filtered.filter(r => r.created_at <= dateTo);
  if (hasOverride === true)  filtered = filtered.filter(r => !!r.human_decision);
  if (hasOverride === false) filtered = filtered.filter(r => !r.human_decision);
  if (guardrailTriggered === true) {
    filtered = filtered.filter(r =>
      Array.isArray(r.guardrail_actions) && r.guardrail_actions.some(g => g && g.triggered === true)
    );
  } else if (guardrailTriggered === false) {
    filtered = filtered.filter(r =>
      !Array.isArray(r.guardrail_actions) || !r.guardrail_actions.some(g => g && g.triggered === true)
    );
  }
  const total = filtered.length;
  const slice = filtered.slice(offset, offset + limit);
  return { rows: slice, total };
}

async function getDecision(id) {
  const { data, error } = await supabase
    .from('ai_decisions').select('*').eq('id', id).single();
  if (error) return null;
  return data;
}

// ── Aggregate stats ───────────────────────────────────────────────────────────

async function stats({ windowDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows = [] } = await supabase
    .from('ai_decisions').select('*');
  const inWindow = rows.filter(r => r.created_at >= cutoff);

  const total = inWindow.length;
  const by_type = {};
  for (const r of inWindow) {
    by_type[r.decision_type] = (by_type[r.decision_type] || 0) + 1;
  }
  const overridden = inWindow.filter(r => !!r.human_decision).length;
  const guardrailHit = inWindow.filter(r =>
    Array.isArray(r.guardrail_actions) && r.guardrail_actions.some(g => g && g.triggered === true)
  ).length;

  const latencies = inWindow.map(r => r.latency_ms).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const median_latency_ms = latencies.length === 0 ? 0
    : (latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]
        : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2));

  const sumIn  = inWindow.reduce((s, r) => s + (r.input_tokens  || 0), 0);
  const sumOut = inWindow.reduce((s, r) => s + (r.output_tokens || 0), 0);

  return {
    window_days:                 windowDays,
    total,
    by_type,
    pct_with_human_override:     total === 0 ? 0 : Math.round((overridden  / total) * 1000) / 10,
    pct_with_guardrail_triggered:total === 0 ? 0 : Math.round((guardrailHit / total) * 1000) / 10,
    median_latency_ms,
    total_input_tokens:          sumIn,
    total_output_tokens:         sumOut,
  };
}

module.exports = { logDecision, linkHumanDecision, listDecisions, getDecision, stats };
