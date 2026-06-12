'use strict';

/**
 * Itemized Reserve Worksheets (CL-RSV1).
 *
 * One worksheet per claim: line items in three categories
 * (medical | indemnity | expense), three shapes:
 *
 *   'quantity'   — quantity × unit_amount        (5 PTP visits × $250)
 *   'weeks_rate' — weeks × weekly rate; when the rate is omitted for an
 *                  indemnity line it comes from claims.td_rate — the
 *                  existing claim record, NEVER a synthesized statutory
 *                  value (PD dollar figures come from the M13 pdService
 *                  outputs and are entered as flat amounts).
 *   'flat'       — flat_amount                   (estimated PD dollars)
 *
 * Totals are computed HERE, server-side, on every write; client-sent
 * totals are ignored.
 *
 * CONTROL BOUNDARY: the worksheet FEEDS the M3 approval workflow and
 * never bypasses it. This service performs no writes to the `reserves`
 * table and no FileHandler calls. getWorksheet() reports the rollup as
 * a PROPOSED reserve change with its approval state against the latest
 * adjuster-approved reserves row; applying it goes through the same
 * claimService.approveReserves gate it always has.
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const logger       = require('../logger');

const CATEGORIES = ['medical', 'indemnity', 'expense'];
const SHAPES     = ['quantity', 'weeks_rate', 'flat'];

function _id() {
  return `rli_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

const _round2 = (n) => Math.round(Number(n) * 100) / 100;

async function _claimOrThrow(claimId) {
  const { data: claim, error } = await supabase
    .from('claims').select('id, td_rate').eq('id', claimId).single();
  if (error || !claim) throw new Error(`Claim not found: ${claimId}`);
  return claim;
}

/**
 * Validate a line-item payload and compute its total. Returns the
 * normalized fields. Throws on anything malformed.
 */
async function _normalize(claimId, input) {
  const { category, label, shape = 'quantity', basis_note } = input || {};
  if (!CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!label || !String(label).trim()) throw new Error('label is required');
  if (!SHAPES.includes(shape)) {
    throw new Error(`shape must be one of: ${SHAPES.join(', ')}`);
  }

  let quantity = null, unit_amount = null, flat_amount = null, total;

  // Operands are quantized to the database precision (NUMERIC(…,2))
  // BEFORE any arithmetic: the stored operands, the displayed formula,
  // and the stored total must all agree. Computing from full-precision
  // inputs (e.g. quantity 1.004 × $100 = $100.40) while Postgres rounds
  // the operand to 1.00 would store a total its own formula contradicts.
  if (shape === 'flat') {
    flat_amount = Number(input.flat_amount);
    if (!Number.isFinite(flat_amount) || flat_amount < 0) {
      throw new Error('flat_amount must be a non-negative number for a flat line');
    }
    flat_amount = _round2(flat_amount);
    total = flat_amount;
  } else {
    quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`quantity must be a positive number for a ${shape} line`);
    }
    quantity = _round2(quantity);
    if (quantity <= 0) {
      throw new Error(`quantity must be a positive number for a ${shape} line (rounds to 0 at the stored 2-decimal precision)`);
    }
    if (input.unit_amount == null && shape === 'weeks_rate' && category === 'indemnity') {
      // TD lines default to the claim's existing weekly rate — the one
      // place a rate is derived, and it comes from the claim record.
      const claim = await _claimOrThrow(claimId);
      if (claim.td_rate == null) {
        throw new Error('unit_amount omitted and the claim has no td_rate to derive it from');
      }
      unit_amount = Number(claim.td_rate);
    } else {
      unit_amount = Number(input.unit_amount);
    }
    if (!Number.isFinite(unit_amount) || unit_amount < 0) {
      throw new Error(`unit_amount must be a non-negative number for a ${shape} line`);
    }
    unit_amount = _round2(unit_amount);
    total = _round2(quantity * unit_amount);
  }

  return {
    category, shape,
    label: String(label).trim(),
    quantity, unit_amount, flat_amount,
    total,
    basis_note: basis_note ? String(basis_note) : null,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function addLineItem(claimId, input, actorEmail) {
  await _claimOrThrow(claimId);
  const fields = await _normalize(claimId, input);
  const now = new Date().toISOString();
  const row = {
    id: _id(),
    claim_id: claimId,
    ...fields,
    created_by: actorEmail || null,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase
    .from('reserve_line_items').insert(row).select().single();
  if (error) throw new Error(`reserveWorksheet: insert failed — ${error.message}`);

  const { error: evErr } = await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'reserve_worksheet_updated', timestamp: now,
    data: { op: 'add', line_item_id: row.id, category: row.category, label: row.label, total: row.total, actor: actorEmail || null },
  });
  if (evErr) logger.error({ msg: 'reserveWorksheet: event insert failed', err: evErr.message });
  return data;
}

async function updateLineItem(itemId, input, actorEmail) {
  const { data: existing, error: exErr } = await supabase
    .from('reserve_line_items').select('*').eq('id', itemId).single();
  if (exErr || !existing) throw new Error(`Line item not found: ${itemId}`);

  const fields = await _normalize(existing.claim_id, { ...existing, ...input });
  const { data, error } = await supabase
    .from('reserve_line_items')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', itemId).select().single();
  if (error) throw new Error(`reserveWorksheet: update failed — ${error.message}`);

  const { error: evErr } = await supabase.from('claim_events').insert({
    claim_id: existing.claim_id, type: 'reserve_worksheet_updated', timestamp: new Date().toISOString(),
    data: { op: 'update', line_item_id: itemId, category: fields.category, label: fields.label, total: fields.total, actor: actorEmail || null },
  });
  if (evErr) logger.error({ msg: 'reserveWorksheet: event insert failed', err: evErr.message });
  return data;
}

async function removeLineItem(itemId, actorEmail) {
  const { data: existing, error: exErr } = await supabase
    .from('reserve_line_items').select('*').eq('id', itemId).single();
  if (exErr || !existing) throw new Error(`Line item not found: ${itemId}`);

  const { error } = await supabase
    .from('reserve_line_items').delete().eq('id', itemId);
  if (error) throw new Error(`reserveWorksheet: delete failed — ${error.message}`);

  const { error: evErr } = await supabase.from('claim_events').insert({
    claim_id: existing.claim_id, type: 'reserve_worksheet_updated', timestamp: new Date().toISOString(),
    data: { op: 'remove', line_item_id: itemId, category: existing.category, label: existing.label, actor: actorEmail || null },
  });
  if (evErr) logger.error({ msg: 'reserveWorksheet: event insert failed', err: evErr.message });
  return { removed: itemId };
}

// ── The worksheet view ────────────────────────────────────────────────────────

/**
 * The full worksheet: items grouped by category, category subtotals,
 * grand total, and the PROPOSED reserve change relative to the latest
 * adjuster-approved reserves row. proposal.status:
 *   'approved'         — worksheet subtotals match the approved reserves
 *   'pending_approval' — they differ; applying requires approveReserves
 *   'no_worksheet'     — no line items yet
 */
async function getWorksheet(claimId) {
  await _claimOrThrow(claimId);

  const { data: items, error } = await supabase
    .from('reserve_line_items').select('*').eq('claim_id', claimId);
  if (error) throw new Error(`reserveWorksheet: read failed — ${error.message}`);

  const sorted = (items || []).sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)));

  const byCategory = {};
  const subtotals = {};
  for (const cat of CATEGORIES) {
    byCategory[cat] = sorted.filter(i => i.category === cat);
    subtotals[cat] = _round2(byCategory[cat].reduce((s, i) => s + Number(i.total || 0), 0));
  }
  const grandTotal = _round2(CATEGORIES.reduce((s, c) => s + subtotals[c], 0));

  // Latest adjuster-approved reserves row (the M3 control point).
  const { data: reserveRows, error: rErr } = await supabase
    .from('reserves').select('*').eq('claim_id', claimId);
  if (rErr) throw new Error(`reserveWorksheet: reserves read failed — ${rErr.message}`);
  const approved = (reserveRows || [])
    .filter(r => r.source === 'ADJUSTER')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;

  const matches = approved &&
    _round2(approved.medical)   === subtotals.medical &&
    _round2(approved.indemnity) === subtotals.indemnity &&
    _round2(approved.expense)   === subtotals.expense;

  return {
    claim_id: claimId,
    items: byCategory,
    subtotals,
    grand_total: grandTotal,
    approved_reserves: approved ? {
      medical: _round2(approved.medical), indemnity: _round2(approved.indemnity),
      expense: _round2(approved.expense), approved_by: approved.approved_by,
      approved_at: approved.created_at, reason: approved.reason,
    } : null,
    proposal: {
      status: sorted.length === 0 ? 'no_worksheet' : (matches ? 'approved' : 'pending_approval'),
      // What approveReserves would be called with — the worksheet can
      // only ever PROPOSE; this service never writes reserves.
      medical: subtotals.medical,
      indemnity: subtotals.indemnity,
      expense: subtotals.expense,
      reason: 'Itemized reserve worksheet rollup',
    },
  };
}

// ── Worksheet-bound approval (the only worksheet → reserves path) ────────────

/**
 * Approve the CURRENT worksheet rollup as reserves, bound to the version
 * the approver was looking at.
 *
 * The client sends `expected` — the {medical, indemnity, expense}
 * subtotals it displayed. The rollup is recomputed server-side at
 * approval time; if any subtotal moved (another admin edited the
 * worksheet after the approver loaded it), the approval is rejected
 * with WORKSHEET_CHANGED and nothing is written. On a match the
 * SERVER-COMPUTED totals — never the client's numbers — flow into the
 * same claimService.approveReserves gate (reserves row + FileHandler),
 * so a stale cache can never become the approved reserve position.
 */
async function approveWorksheet(claimId, expected, adjusterEmail) {
  if (!expected || ['medical', 'indemnity', 'expense'].some(k => !Number.isFinite(Number(expected[k])))) {
    throw new Error('expected must carry the medical/indemnity/expense subtotals the approver reviewed');
  }

  const ws = await getWorksheet(claimId);
  if (ws.proposal.status === 'no_worksheet') {
    throw new Error('No worksheet to approve — the claim has no reserve line items');
  }

  const drift = CATEGORIES.filter(c => _round2(Number(expected[c])) !== ws.subtotals[c]);
  if (drift.length > 0) {
    throw new Error(
      `WORKSHEET_CHANGED — the worksheet was modified after it was reviewed (` +
      drift.map(c => `${c}: reviewed ${_round2(Number(expected[c]))}, now ${ws.subtotals[c]}`).join('; ') +
      '). Reload the worksheet and approve the current totals.');
  }

  const claimService = require('./claimService');
  const updated = await claimService.approveReserves(claimId, {
    medical: ws.subtotals.medical,
    indemnity: ws.subtotals.indemnity,
    expense: ws.subtotals.expense,
    reason: 'Itemized reserve worksheet rollup',
  }, adjusterEmail);

  return { approved: ws.subtotals, claim: updated };
}

module.exports = {
  addLineItem,
  updateLineItem,
  removeLineItem,
  getWorksheet,
  approveWorksheet,
  CATEGORIES,
  SHAPES,
};
