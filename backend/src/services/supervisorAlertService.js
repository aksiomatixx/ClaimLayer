'use strict';

/**
 * Supervisor Daily Alerts (CL-SUP1).
 *
 * Each business morning, every supervisor gets a digest of
 *   1. DUE TODAY (important): open diaries due today that are CRITICAL
 *      or no_snooze — the ones that cannot wait, and
 *   2. OVERDUE: every open diary past its due date, regardless of
 *      priority,
 * across all claims and adjusters, grouped by adjuster then claim.
 *
 * DETERMINISTIC ONLY: plain queries over the diaries/claims tables —
 * no model call anywhere in this feature.
 *
 * Generation is idempotent per (alert_date, recipient): re-running the
 * cron for the same date updates the snapshot and counts; it never
 * duplicates, and it preserves an existing acknowledgement.
 *
 * Delivery: the in-app supervisor panel reads the stored row; email
 * goes through a NOTIFY_ADAPTER-selected adapter (stub default — logs
 * the rendered digest and, mirroring the WCIS stub convention, WARNs
 * loudly when running stubbed in production).
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const logger       = require('../logger');

function _id() {
  return `sva_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Today's date in America/Los_Angeles (the book runs on CA time). */
function todayLA() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const _daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// ── The two scope queries (named, tested) ─────────────────────────────────────

async function _openDiaries() {
  const { data, error } = await supabase.from('diaries').select('*').eq('status', 'open');
  if (error) throw new Error(`supervisorAlert: diaries read failed — ${error.message}`);
  return data || [];
}

/**
 * DUE TODAY (important): open diaries with due_date = date AND
 * (priority CRITICAL OR no_snooze).
 */
async function dueTodayImportant(date) {
  return (await _openDiaries()).filter(d =>
    d.due_date === date && (d.priority === 'CRITICAL' || d.no_snooze === true));
}

/** OVERDUE: ALL open diaries with due_date < date, any priority. */
async function overdue(date) {
  return (await _openDiaries()).filter(d => d.due_date && d.due_date < date);
}

// ── Digest assembly ───────────────────────────────────────────────────────────

async function _claimFacts(claimIds) {
  const facts = {};
  for (const id of [...new Set(claimIds)]) {
    const { data } = await supabase
      .from('claims').select('id, claim_number, employee').eq('id', id).single();
    const emp = data?.employee || {};
    facts[id] = {
      claim_number: data?.claim_number || id,
      worker: [emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Unknown worker',
    };
  }
  return facts;
}

function _row(d, facts, date) {
  const f = facts[d.claim_id] || { claim_number: d.claim_id, worker: 'Unknown worker' };
  return {
    diary_id: d.id,
    diary_type: d.diary_type,
    claim_id: d.claim_id,
    claim_number: f.claim_number,
    worker: f.worker,
    due_date: d.due_date,
    priority: d.priority || null,
    no_snooze: !!d.no_snooze,
    days_overdue: d.due_date && d.due_date < date ? _daysBetween(d.due_date, date) : 0,
  };
}

function _groupByAdjuster(rows) {
  const byAdjuster = {};
  for (const r of rows) {
    const adj = r.assigned_to || 'unassigned';
    (byAdjuster[adj] = byAdjuster[adj] || []).push(r);
  }
  // Stable ordering: adjusters alphabetical, rows by claim then due date.
  return Object.keys(byAdjuster).sort().map(adjuster => ({
    adjuster,
    items: byAdjuster[adjuster].sort((a, b) =>
      a.claim_number.localeCompare(b.claim_number) ||
      String(a.due_date).localeCompare(String(b.due_date))),
  }));
}

/** The full digest for a date — both sections, grouped adjuster → claim. */
async function buildDigest(date) {
  const [dueRows, overdueRows] = await Promise.all([dueTodayImportant(date), overdue(date)]);
  const facts = await _claimFacts([...dueRows, ...overdueRows].map(d => d.claim_id));

  const tag = (list) => list.map(d => ({ ..._row(d, facts, date), assigned_to: d.assigned_to || 'unassigned' }));
  return {
    alert_date: date,
    due_today: _groupByAdjuster(tag(dueRows)),
    overdue: _groupByAdjuster(tag(overdueRows)),
    due_today_count: dueRows.length,
    overdue_count: overdueRows.length,
  };
}

// ── Recipients ────────────────────────────────────────────────────────────────

/** Supervisors come from the existing users table role model. */
async function supervisorRecipients() {
  const { data, error } = await supabase.from('users').select('*').eq('role', 'supervisor');
  if (error) throw new Error(`supervisorAlert: recipient lookup failed — ${error.message}`);
  return data || [];
}

// ── Generation (idempotent per recipient/date) ───────────────────────────────

async function generate(date = todayLA()) {
  const recipients = await supervisorRecipients();
  if (recipients.length === 0) {
    logger.warn({ msg: 'supervisorAlert: no supervisor-role users — nothing generated', date });
    return { date, recipients: 0, alerts: [] };
  }

  const digest = await buildDigest(date);
  const alerts = [];

  for (const sup of recipients) {
    const recipientId = sup.email || sup.id;
    const { data: existing, error: exErr } = await supabase
      .from('supervisor_alerts').select('*')
      .eq('alert_date', date).eq('recipient_user_id', recipientId);
    if (exErr) throw new Error(`supervisorAlert: existing lookup failed — ${exErr.message}`);

    const now = new Date().toISOString();
    if (existing && existing.length > 0) {
      // Idempotent re-run: refresh the snapshot, preserve the ack.
      const { data: updated, error: upErr } = await supabase.from('supervisor_alerts')
        .update({
          payload: digest,
          due_today_count: digest.due_today_count,
          overdue_count: digest.overdue_count,
          updated_at: now,
        })
        .eq('id', existing[0].id).select().single();
      if (upErr) throw new Error(`supervisorAlert: update failed — ${upErr.message}`);
      alerts.push(updated);
    } else {
      const row = {
        id: _id(),
        alert_date: date,
        recipient_user_id: recipientId,
        payload: digest,
        due_today_count: digest.due_today_count,
        overdue_count: digest.overdue_count,
        created_at: now,
        updated_at: now,
        acknowledged_at: null,
        acknowledged_by: null,
      };
      const { data: inserted, error: insErr } = await supabase
        .from('supervisor_alerts').insert(row).select().single();
      if (insErr) throw new Error(`supervisorAlert: insert failed — ${insErr.message}`);
      alerts.push(inserted);
      await _notify(recipientId, digest);
    }
  }

  return { date, recipients: recipients.length, alerts };
}

/** The latest alert for the requesting supervisor. */
async function currentFor(recipientId) {
  const { data, error } = await supabase
    .from('supervisor_alerts').select('*').eq('recipient_user_id', recipientId);
  if (error) throw new Error(`supervisorAlert: read failed — ${error.message}`);
  return (data || []).sort((a, b) =>
    String(b.alert_date).localeCompare(String(a.alert_date)))[0] || null;
}

/** Acknowledge — recorded with the acting user in the audit trail. */
async function acknowledge(alertId, actorEmail) {
  const { data: alert, error } = await supabase
    .from('supervisor_alerts').select('*').eq('id', alertId).single();
  if (error || !alert) throw new Error(`Alert not found: ${alertId}`);
  if (alert.acknowledged_at) return alert; // idempotent

  const now = new Date().toISOString();
  const { data: updated, error: upErr } = await supabase.from('supervisor_alerts')
    .update({ acknowledged_at: now, acknowledged_by: actorEmail || null, updated_at: now })
    .eq('id', alertId).select().single();
  if (upErr) throw new Error(`supervisorAlert: acknowledge failed — ${upErr.message}`);

  const { error: auErr } = await supabase.from('audit_log').insert({
    action: 'supervisor_alert_acknowledged', resource_type: 'supervisor_alert', resource_id: alertId,
    description: `Daily alert ${alert.alert_date} acknowledged (${alert.due_today_count} due today, ${alert.overdue_count} overdue)`,
    actor: actorEmail || null, created_at: now,
  });
  if (auErr) throw new Error(`supervisorAlert: acknowledge audit failed — ${auErr.message}`);
  return updated;
}

// ── Email delivery adapter (NOTIFY_ADAPTER convention) ───────────────────────

function _renderDigestText(digest) {
  const lines = [`Supervisor daily alert — ${digest.alert_date}`,
    `${digest.due_today_count} important due today · ${digest.overdue_count} overdue`, ''];
  const section = (title, groups) => {
    lines.push(title);
    if (groups.length === 0) lines.push('  (none)');
    for (const g of groups) {
      lines.push(`  ${g.adjuster}:`);
      for (const i of g.items) {
        lines.push(`    ${i.claim_number} · ${i.worker} · ${i.diary_type} · due ${i.due_date}` +
          (i.days_overdue > 0 ? ` (${i.days_overdue}d overdue)` : ''));
      }
    }
    lines.push('');
  };
  section('DUE TODAY (CRITICAL / no-snooze):', digest.due_today);
  section('OVERDUE (all open):', digest.overdue);
  return lines.join('\n');
}

const NOTIFY_ADAPTERS = {
  stub: {
    name: 'stub',
    async send(recipientId, digest) {
      if (process.env.NODE_ENV === 'production') {
        // Mirror the WCIS stub convention: stubs in production scream.
        logger.warn({
          warning: 'NOTIFY_ADAPTER_STUB',
          msg: 'SUPERVISOR DIGEST NOT EMAILED — NOTIFY_ADAPTER=stub in production; wire a real adapter',
          recipient: recipientId,
        });
      }
      logger.info({ msg: 'supervisorAlert digest (stub delivery)', recipient: recipientId, rendered: _renderDigestText(digest) });
      return { sent: false, stub: true };
    },
  },
};

async function _notify(recipientId, digest) {
  const name = process.env.NOTIFY_ADAPTER || 'stub';
  const adapter = NOTIFY_ADAPTERS[name];
  if (!adapter) {
    logger.error({ msg: `supervisorAlert: unknown NOTIFY_ADAPTER "${name}" — digest not delivered`, recipient: recipientId });
    return { sent: false, error: 'unknown_adapter' };
  }
  try {
    return await adapter.send(recipientId, digest);
  } catch (e) {
    logger.error({ msg: 'supervisorAlert: notify failed (alert row already stored)', err: e.message });
    return { sent: false, error: e.message };
  }
}

module.exports = {
  dueTodayImportant,
  overdue,
  buildDigest,
  supervisorRecipients,
  generate,
  currentFor,
  acknowledge,
  todayLA,
  _renderDigestText,
  NOTIFY_ADAPTERS,
};
