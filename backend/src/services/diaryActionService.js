'use strict';

/**
 * Action-Queue Aftermath Automation (Tier 1 — hardened).
 *
 * The outbound half of the inversion's operating contract: when the
 * adjuster completes a queued action, everything after the decision
 * executes itself —
 *
 *   1. the statutory notices the decision requires are generated and
 *      queued for delivery (Notice Library + Delivery Orchestration),
 *   2. the next deadline diaries are set,
 *   3. the decision is documented (audit log + claim event + linkage to
 *      the AI recommendation it accepted or overrode),
 *   4. claim status transitions fire where the decision implies one
 *      (which in turn fires the already-wired WCIS triggers),
 *   5. the system-of-record write-back goes through the transactional
 *      outbox (integration_outbox) — durable and retryable, never a
 *      silent fire-and-forget.
 *
 * ATOMICITY + IDEMPOTENCY (Finding 5 of the production-hardening pass):
 *
 *   - completeAction CLAIMS the diary first with a conditional update
 *     (open → completing). Two concurrent completions cannot both run
 *     the aftermath; the loser gets "Diary is not open".
 *   - The local workflow is one durable unit: notices, successor
 *     diaries, outbox rows, events, audit record, status transition,
 *     then the completed flip. If any required step fails, everything
 *     created in the unit is compensated and the diary returns to
 *     open — the diary is NEVER marked completed on partial aftermath.
 *   - Retries after a crash (stale 'completing' older than
 *     STALE_COMPLETING_MS) are idempotent: notices carry
 *     source_diary_id and successors carry an idempotency key, so a
 *     re-run never duplicates either.
 *   - Every Supabase result is error-checked.
 *
 * AFTERMATH_RULES is deterministic policy-in-code, keyed by
 * (diary_type, decision.action). previewAftermath() renders the same
 * rules as a dry run so the drawer can show the adjuster exactly what
 * completing an action will do — before they do it.
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');

const STALE_COMPLETING_MS = 10 * 60 * 1000;

function _rid(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function _addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ── The rules ─────────────────────────────────────────────────────────────────
// outcome := { notices: [{type, ctx}], successors: [{diary_type, due_days,
//              priority, notes}], status_to, ai_link: decision_type }
const AFTERMATH_RULES = {
  COMPENSABILITY_DECISION_DUE: {
    decisions: {
      accept: {
        describe: 'Accept the claim',
        notices: [{ type: 'claim_accepted' }],
        successors: [{ diary_type: 'TD_PAYMENT_SETUP', due_days: 3, priority: 'HIGH',
                       notes: 'Claim accepted — set up TD benefits if the worker is losing time.' }],
        status_to: 'accepted',
        ai_link: 'compensability',
      },
      deny: {
        describe: 'Deny the claim (licensed-human-only action)',
        notices: [{ type: 'claim_denied' }],
        successors: [],
        status_to: 'denied',
        ai_link: 'compensability',
      },
      delay: {
        describe: 'Delay the decision within the LC §5402 window',
        notices: [],
        // The ceiling makes the LC §5402 deadline immutable: a delay can
        // reschedule the review, never the statute. Successors are capped
        // at the original statutory deadline (stored on the diary at
        // creation, derived from DOI+90 as the fallback); if the deadline
        // has already passed, no successor is created — a CRITICAL
        // escalation surfaces instead.
        successors: [{ diary_type: 'COMPENSABILITY_DECISION_DUE', due_days: 30, priority: 'CRITICAL',
                       notes: 'Delayed decision — LC §5402 90-day window still running.',
                       ceiling: { basis: 'doi_plus_days', days: 90, cite: 'LC §5402' } }],
        ai_link: 'compensability',
      },
    },
  },
  TD_PAYMENT_REVIEW: {
    decisions: {
      continue: {
        describe: 'Continue TD at the current rate',
        notices: [],
        successors: [{ diary_type: 'TD_PAYMENT_REVIEW', due_days: 14, priority: 'HIGH',
                       notes: 'Next biweekly TD payment review (LC §4650 cycle).' }],
      },
      suspend: {
        describe: 'Suspend TD (close the period via the Benefits tab — SROI fires there)',
        notices: [{ type: 'td_suspension' }],
        successors: [],
      },
      rate_change: {
        describe: 'Change the TD rate (apply via the Benefits tab — SROI CA fires there)',
        notices: [{ type: 'td_rate_change' }],
        successors: [{ diary_type: 'TD_PAYMENT_REVIEW', due_days: 14, priority: 'HIGH',
                       notes: 'Next biweekly TD payment review at the new rate.' }],
      },
    },
  },
  RFA_INTAKE_REVIEW: {
    decisions: {
      route_to_mtus: {
        describe: 'Route the RFA into MTUS evaluation',
        notices: [],
        successors: [],
        ai_link: 'rfa_mtus',
      },
    },
  },
  PR4_RECEIVED_REVIEW: {
    decisions: {
      start_rating: {
        describe: 'Accept P&S and start the PD rating pathway',
        notices: [{ type: 'ps_mmi_rating' }],
        successors: [{ diary_type: 'PD_CALC_DUE', due_days: 5, priority: 'HIGH',
                       notes: 'Run the PD calculation from the PR-4 WPI.' }],
      },
    },
  },
  REPRESENTATION_REVIEW: {
    decisions: {
      confirmed: {
        describe: 'Confirm the representation change (record it via the representation workflow)',
        notices: [],
        successors: [],
      },
    },
  },
  CNR_OFFER_FOLLOWUP: {
    decisions: {
      followed_up: {
        describe: 'Follow-up complete — keep the offer cycle alive',
        notices: [],
        successors: [{ diary_type: 'CNR_OFFER_FOLLOWUP', due_days: 14, priority: 'MEDIUM',
                       notes: 'Next C&R offer follow-up with worker / attorney.' }],
      },
    },
  },
};

// Generic completion for diary types without specific rules: complete +
// document, no automated aftermath.
const GENERIC_OUTCOME = { describe: 'Complete the action', notices: [], successors: [] };

function _resolveOutcome(diaryType, action) {
  const rule = AFTERMATH_RULES[diaryType];
  if (!rule) return action === 'complete' || !action ? GENERIC_OUTCOME : null;
  return rule.decisions[action] || null;
}

function _validActions(diaryType) {
  const rule = AFTERMATH_RULES[diaryType];
  return rule ? Object.keys(rule.decisions) : ['complete'];
}

// ── Preview (dry run for the drawer) ─────────────────────────────────────────

async function previewAftermath(diaryId) {
  const { data: diary, error } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (error || !diary) throw new Error(`Diary not found: ${diaryId}`);

  const actions = _validActions(diary.diary_type).map(action => {
    const o = _resolveOutcome(diary.diary_type, action);
    return {
      action,
      describe: o.describe,
      will: [
        'Complete this diary and document the decision',
        ...(o.ai_link ? [`Link your decision to the ${o.ai_link} AI recommendation in the audit trail`] : []),
        ...o.notices.map(n => `Generate + queue the "${n.type}" statutory notice (attorney copy if represented)`),
        ...o.successors.map(s => `Set the next diary: ${s.diary_type} due in ${s.due_days} days (${s.priority}${s.ceiling ? `; capped at the ${s.ceiling.cite} statutory deadline` : ''})`),
        ...(o.status_to ? [`Transition the claim to "${o.status_to}" (WCIS reporting fires automatically)`] : []),
      ],
    };
  });
  return { diary_id: diaryId, diary_type: diary.diary_type, actions };
}

// ── Claiming (the concurrency gate) ──────────────────────────────────────────

/**
 * Claim a diary for a decision workflow: open → completing via
 * conditional update. A stale 'completing' (crashed worker) is
 * reclaimable after STALE_COMPLETING_MS — the idempotency keys on
 * notices/successors make the re-run safe.
 */
async function _claimDiary(diary) {
  const now = new Date().toISOString();

  if (diary.status === 'open') {
    const { data, error } = await supabase.from('diaries')
      .update({ status: 'completing', updated_at: now })
      .eq('id', diary.id).eq('status', 'open')
      .select();
    if (error) throw new Error(`diaryAction: claim failed — ${error.message}`);
    return (data || []).length > 0;
  }

  if (diary.status === 'completing' &&
      diary.updated_at && (Date.now() - Date.parse(diary.updated_at)) > STALE_COMPLETING_MS) {
    const { data, error } = await supabase.from('diaries')
      .update({ status: 'completing', updated_at: now })
      .eq('id', diary.id).eq('status', 'completing').eq('updated_at', diary.updated_at)
      .select();
    if (error) throw new Error(`diaryAction: stale reclaim failed — ${error.message}`);
    if ((data || []).length > 0) {
      logger.warn({ msg: 'diaryAction: reclaimed stale completing diary', diaryId: diary.id });
      return true;
    }
  }

  return false;
}

// ── Compensation (rollback of the durable unit) ──────────────────────────────

async function _rollback(diary, created, failure) {
  const now = new Date().toISOString();
  try {
    for (const s of created.successorIds) {
      await supabase.from('diaries').delete().eq('id', s);
    }
    for (const nid of created.noticeIds) {
      await supabase.from('benefit_notice_channels').delete().eq('notice_id', nid);
      await supabase.from('benefit_notices').delete().eq('id', nid);
    }
    for (const did of created.noticeDocIds) {
      await supabase.from('claim_documents').update({ status: 'superseded', updated_at: now }).eq('id', did);
    }
    for (const eid of created.eventIds) {
      await supabase.from('claim_events').delete().eq('id', eid);
    }
    if (created.outboxIds.length) {
      const outbox = require('./outboxService');
      await outbox.removeRows(created.outboxIds);
    }
    if (created.prevStatus) {
      // Direct restore of the prior claim status — honest compensation,
      // documented in the failure event below.
      await supabase.from('claims').update({ status: created.prevStatus, updated_at: now }).eq('id', diary.claim_id);
    }
    await supabase.from('claim_events').insert({
      claim_id: diary.claim_id, type: 'action_completion_failed', timestamp: now,
      data: {
        diary_id: diary.id, diary_type: diary.diary_type,
        error: failure.message, rolled_back: true,
        status_restored: created.prevStatus || null,
      },
    });
  } catch (e) {
    logger.error({ msg: 'diaryAction: ROLLBACK ITSELF FAILED — manual reconciliation required', diaryId: diary.id, rollbackErr: e.message, originalErr: failure.message });
  } finally {
    // Whatever else happened, the diary must not stay claimed.
    await supabase.from('diaries')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', diary.id).eq('status', 'completing');
  }
}

// ── Completion ────────────────────────────────────────────────────────────────

async function completeAction(diaryId, { action, note } = {}, actorEmail) {
  const { data: diary, error: dErr } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (dErr || !diary) throw new Error(`Diary not found: ${diaryId}`);
  if (!['open', 'completing'].includes(diary.status)) throw new Error('Diary is not open');

  const outcome = _resolveOutcome(diary.diary_type, action || 'complete');
  if (!outcome) {
    throw new Error(
      `Unknown action "${action}" for ${diary.diary_type}. Valid: ${_validActions(diary.diary_type).join(', ')}`);
  }

  // The concurrency gate: only one completion may claim the diary.
  if (!(await _claimDiary(diary))) throw new Error('Diary is not open');

  const claimId = diary.claim_id;
  const now = new Date().toISOString();
  const created = { noticeIds: [], noticeDocIds: [], successorIds: [], eventIds: [], outboxIds: [], prevStatus: null };
  const noticesGenerated = [];
  const successors = [];
  const escalations = [];
  let statusTransition = null;

  try {
    // 1. Generate + queue the required notices (idempotent on
    //    source_diary_id — a crashed re-run never duplicates them).
    const noticeTemplates = require('./noticeTemplateService');
    const delivery = require('./noticeDeliveryService');
    const { data: priorNotices, error: pnErr } = await supabase
      .from('benefit_notices').select('*').eq('source_diary_id', diaryId);
    if (pnErr) throw new Error(`prior-notice lookup failed: ${pnErr.message}`);
    const priorTypes = new Set((priorNotices || []).map(n => n.notice_type));

    for (const n of outcome.notices) {
      if (priorTypes.has(n.type)) {
        for (const row of priorNotices.filter(p => p.notice_type === n.type)) {
          noticesGenerated.push({ id: row.id, type: row.notice_type, audience: row.audience, status: row.status });
        }
        continue;
      }
      const { notices, document } = await noticeTemplates.generateNotice(
        n.type, claimId,
        { ...(n.ctx || {}), decision_note: note, event_date: now.split('T')[0] },
        { source_diary_id: diaryId },
      );
      if (document) created.noticeDocIds.push(document.id);
      for (const row of notices) {
        created.noticeIds.push(row.id);
        const queued = await delivery.queueNotice(row.id);
        noticesGenerated.push({ id: row.id, type: row.notice_type, audience: row.audience, status: queued.status });
      }
    }

    // 2. Set the successor diaries (idempotent on the successor key).
    //    Successors with a statutory ceiling are capped at the immutable
    //    original deadline; a deadline already in the past produces a
    //    CRITICAL escalation instead of a successor (Finding 6).
    for (const s of outcome.successors) {
      const idemKey = `succ:${diaryId}:${s.diary_type}`;
      const { data: existing, error: exErr } = await supabase
        .from('diaries').select('*').eq('idempotency_key', idemKey);
      if (exErr) throw new Error(`successor lookup failed: ${exErr.message}`);
      if (existing && existing.length > 0) {
        successors.push(existing[0]);
        continue;
      }

      let dueDate = _addDays(s.due_days);
      let statutoryDeadline = null;
      if (s.ceiling) {
        statutoryDeadline = diary.statutory_deadline ||
          await _deriveCeiling(claimId, s.ceiling);
        const today = new Date().toISOString().split('T')[0];
        if (statutoryDeadline && statutoryDeadline < today) {
          // The statutory deadline has PASSED — never reschedule past
          // it. Surface an immediate critical escalation instead.
          const esc = {
            id: _rid('diy'),
            claim_id: claimId,
            diary_type: 'STATUTORY_DEADLINE_ESCALATION',
            due_date: today,
            assigned_to: config.adjuster.email,
            priority: 'CRITICAL', status: 'open', no_snooze: true,
            parent_diary_id: diaryId,
            idempotency_key: `esc:${diaryId}:${s.diary_type}`,
            statutory_deadline: statutoryDeadline,
            notes: `${s.ceiling.cite} statutory deadline ${statutoryDeadline} has PASSED — ` +
                   `the ${s.diary_type} decision cannot be delayed further. ` +
                   'Presumption/penalty exposure: resolve immediately.',
            created_at: now,
          };
          const { error: escErr } = await supabase.from('diaries').insert(esc);
          if (escErr) throw new Error(`escalation insert failed: ${escErr.message}`);
          created.successorIds.push(esc.id);
          escalations.push(esc);

          const breachEv = {
            id: _rid('evt'),
            claim_id: claimId, type: 'statutory_deadline_breached', timestamp: now,
            data: { diary_id: diaryId, diary_type: s.diary_type, cite: s.ceiling.cite,
                    statutory_deadline: statutoryDeadline, escalation_diary_id: esc.id },
          };
          const { error: bevErr } = await supabase.from('claim_events').insert(breachEv);
          if (bevErr) throw new Error(`breach event insert failed: ${bevErr.message}`);
          created.eventIds.push(breachEv.id);
          continue;
        }
        if (statutoryDeadline && dueDate > statutoryDeadline) {
          dueDate = statutoryDeadline; // capped at the immutable original deadline
        }
      }

      const row = {
        id: _rid('diy'),
        claim_id: claimId, diary_type: s.diary_type,
        due_date: dueDate, assigned_to: config.adjuster.email,
        priority: s.priority, status: 'open', notes: s.notes,
        parent_diary_id: diaryId,
        idempotency_key: idemKey,
        statutory_deadline: statutoryDeadline,
        ...(statutoryDeadline ? { no_snooze: true } : {}),
        created_at: now,
      };
      const { error: insErr } = await supabase.from('diaries').insert(row);
      if (insErr) throw new Error(`successor insert failed: ${insErr.message}`);
      created.successorIds.push(row.id);
      successors.push(row);
    }

    // 3. System-of-record write-back through the transactional outbox —
    //    durable rows inside this unit, dispatched after it commits.
    created.outboxIds = await _enqueueWriteBack(claimId, diary, outcome, { action, note }, actorEmail, created);

    // 4. Document the decision.
    const evRow = {
      id: _rid('evt'),
      claim_id: claimId, type: 'action_completed', timestamp: now,
      data: { diary_id: diaryId, diary_type: diary.diary_type, action: action || 'complete', note: note || null, actor: actorEmail || null },
    };
    const { error: evErr } = await supabase.from('claim_events').insert(evRow);
    if (evErr) throw new Error(`event insert failed: ${evErr.message}`);
    created.eventIds.push(evRow.id);

    const { error: auErr } = await supabase.from('audit_log').insert({
      action: 'action_completed', resource_type: 'diary', resource_id: diaryId,
      description: `${diary.diary_type}: ${outcome.describe}${note ? ` — ${note}` : ''}`,
      actor: actorEmail || null, created_at: now,
    });
    if (auErr) throw new Error(`audit insert failed: ${auErr.message}`);

    // 5. Status transition (fires the already-wired WCIS triggers).
    if (outcome.status_to) {
      const { data: claimRow, error: cErr } = await supabase
        .from('claims').select('status').eq('id', claimId).single();
      if (cErr) throw new Error(`claim lookup failed: ${cErr.message}`);
      const claimService = require('./claimService');
      await claimService.updateStatus(claimId, outcome.status_to, actorEmail || 'aftermath-automation');
      created.prevStatus = claimRow?.status || null;
      statusTransition = outcome.status_to;
    }

    // 6. Commit point: completing → completed with the decision on it.
    const { data: finalized, error: finErr } = await supabase.from('diaries').update({
      status: 'completed',
      completed_at: now,
      completed_by: actorEmail || null,
      decision_action: action || 'complete',
      decision_note: note || null,
      updated_at: new Date().toISOString(),
    }).eq('id', diaryId).eq('status', 'completing').select();
    if (finErr) throw new Error(`finalize failed: ${finErr.message}`);
    if (!finalized || finalized.length === 0) throw new Error('finalize failed: claim was lost');
  } catch (e) {
    logger.error({ msg: 'completeAction: aftermath failed — rolling back', diaryId, err: e.message });
    await _rollback(diary, created, e);
    throw new Error(`Action not completed — required aftermath failed and was rolled back: ${e.message}`);
  }

  // ── The local unit is durable. Best-effort extras follow. ──────────────────

  // Link the human decision to the AI recommendation it accepted/overrode.
  if (outcome.ai_link) {
    try {
      const aid = require('./aiDecisionsService');
      await aid.linkHumanDecision(claimId, outcome.ai_link, {
        human_decision: `${diary.diary_type}:${action}`,
        human_decision_at: now,
        human_decision_by: actorEmail || null,
      });
    } catch (e) {
      logger.warn({ msg: 'completeAction: ai link failed (non-fatal)', err: e.message });
    }
  }

  // Opportunistic outbox dispatch — failures stay pending for the worker.
  await _dispatchOutbox(created.outboxIds);

  return {
    diary_id: diaryId,
    diary_type: diary.diary_type,
    action: action || 'complete',
    notices_generated: noticesGenerated,
    successor_diaries: successors.map(s => ({ id: s.id, diary_type: s.diary_type, due_date: s.due_date, statutory_deadline: s.statutory_deadline || null })),
    escalations: escalations.map(e => ({ id: e.id, diary_type: e.diary_type, due_date: e.due_date, statutory_deadline: e.statutory_deadline })),
    status_transition: statusTransition,
  };
}

/**
 * Derive a successor's statutory ceiling when the parent diary does not
 * carry one (legacy rows): doi_plus_days anchors to the claim's
 * date_of_injury — immutable, so the ceiling cannot drift.
 */
async function _deriveCeiling(claimId, ceiling) {
  if (ceiling.basis !== 'doi_plus_days') return null;
  const { data: claim, error } = await supabase
    .from('claims').select('date_of_injury').eq('id', claimId).single();
  if (error || !claim?.date_of_injury) return null;
  const d = new Date(`${claim.date_of_injury}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ceiling.days);
  return d.toISOString().split('T')[0];
}

// ── System-of-record write-back (outbox rows) ────────────────────────────────

async function _enqueueWriteBack(claimId, diary, outcome, decision, actorEmail) {
  const { data: claim, error } = await supabase
    .from('claims').select('filehandler_id').eq('id', claimId).single();
  if (error && error.code !== 'PGRST116') {
    throw new Error(`claim lookup for write-back failed: ${error.message}`);
  }
  if (!claim?.filehandler_id) return [];

  const outbox = require('./outboxService');
  const noteText =
    `[ClaimLayer] ${diary.diary_type} — ${outcome.describe}` +
    `${decision.note ? `: ${decision.note}` : ''} (action: ${decision.action || 'complete'})`;

  const entries = [{
    target: 'filehandler', operation: 'add_note', claim_id: claimId,
    payload: { fh_claim_id: claim.filehandler_id, note_text: noteText, added_by: actorEmail || 'ADJUSTER' },
  }];
  if (diary.fh_diary_id) {
    entries.push({
      target: 'filehandler', operation: 'complete_diary', claim_id: claimId,
      payload: {
        fh_claim_id: claim.filehandler_id, fh_diary_id: diary.fh_diary_id,
        completion_note: decision.note || outcome.describe, completed_by: actorEmail || 'ADJUSTER',
      },
    });
  }
  const rows = await outbox.enqueue(entries);
  return rows.map(r => r.id);
}

async function _dispatchOutbox(outboxIds) {
  if (!outboxIds || outboxIds.length === 0) return;
  const outbox = require('./outboxService');
  for (const id of outboxIds) {
    try {
      await outbox.dispatchOne(id, 'inline-aftermath');
    } catch (e) {
      logger.warn({ msg: 'completeAction: opportunistic outbox dispatch failed — worker will retry', outboxId: id, err: e.message });
    }
  }
}

/**
 * Decline a queued action: the licensed human disagrees with the prepared
 * decision. The diary is cancelled WITH a documented reason — no aftermath
 * runs, nothing is silently dropped. Claimed the same way as completion,
 * so concurrent decline/complete cannot both win.
 */
async function declineAction(diaryId, { reason } = {}, actorEmail) {
  const { data: diary, error: dErr } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (dErr || !diary) throw new Error(`Diary not found: ${diaryId}`);
  if (!['open', 'completing'].includes(diary.status)) throw new Error('Diary is not open');
  if (!reason || !String(reason).trim()) {
    throw new Error('A decline reason is required — declined actions are documented, never dropped');
  }

  if (!(await _claimDiary(diary))) throw new Error('Diary is not open');

  const now = new Date().toISOString();
  const created = { noticeIds: [], noticeDocIds: [], successorIds: [], eventIds: [], outboxIds: [], prevStatus: null };

  try {
    created.outboxIds = await _enqueueWriteBack(diary.claim_id, diary,
      { describe: 'Action declined' }, { action: 'declined', note: reason }, actorEmail);

    const evRow = {
      id: _rid('evt'),
      claim_id: diary.claim_id, type: 'action_declined', timestamp: now,
      data: { diary_id: diaryId, diary_type: diary.diary_type, reason, actor: actorEmail || null },
    };
    const { error: evErr } = await supabase.from('claim_events').insert(evRow);
    if (evErr) throw new Error(`event insert failed: ${evErr.message}`);
    created.eventIds.push(evRow.id);

    const { error: auErr } = await supabase.from('audit_log').insert({
      action: 'action_declined', resource_type: 'diary', resource_id: diaryId,
      description: `${diary.diary_type} declined: ${reason}`,
      actor: actorEmail || null, created_at: now,
    });
    if (auErr) throw new Error(`audit insert failed: ${auErr.message}`);

    const { data: finalized, error: finErr } = await supabase.from('diaries').update({
      status: 'cancelled',
      completed_at: now,
      completed_by: actorEmail || null,
      decision_action: 'declined',
      decision_note: reason,
      updated_at: new Date().toISOString(),
    }).eq('id', diaryId).eq('status', 'completing').select();
    if (finErr) throw new Error(`finalize failed: ${finErr.message}`);
    if (!finalized || finalized.length === 0) throw new Error('finalize failed: claim was lost');
  } catch (e) {
    logger.error({ msg: 'declineAction: failed — rolling back', diaryId, err: e.message });
    await _rollback(diary, created, e);
    throw new Error(`Decline not recorded — ${e.message}`);
  }

  await _dispatchOutbox(created.outboxIds);

  return { diary_id: diaryId, diary_type: diary.diary_type, status: 'cancelled', reason };
}

/**
 * Edit a queued action before deciding it: due date, priority, or notes.
 * Every edit is audited — the queue is the compliance contract, so moving
 * a deadline is itself a documented act.
 */
async function editAction(diaryId, { due_date, priority, notes } = {}, actorEmail) {
  const { data: diary, error: dErr } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (dErr || !diary) throw new Error(`Diary not found: ${diaryId}`);
  if (diary.status !== 'open') throw new Error('Diary is not open');
  if (diary.no_snooze && due_date && due_date > diary.due_date) {
    throw new Error('NO_SNOOZE_DIARY — statutory penalty diaries cannot be pushed out');
  }
  if (diary.statutory_deadline && due_date && due_date > diary.statutory_deadline) {
    throw new Error(
      `STATUTORY_DEADLINE_CEILING — this diary's statutory deadline is ${diary.statutory_deadline}; ` +
      'it cannot be rescheduled beyond it');
  }

  const patch = { updated_at: new Date().toISOString() };
  const changes = {};
  if (due_date)  { patch.due_date = due_date;   changes.due_date = { from: diary.due_date, to: due_date }; }
  if (priority)  { patch.priority = priority;   changes.priority = { from: diary.priority, to: priority }; }
  if (notes !== undefined) { patch.notes = notes; changes.notes = true; }
  if (Object.keys(changes).length === 0) throw new Error('Nothing to edit');

  const { data: updated, error: upErr } = await supabase.from('diaries')
    .update(patch).eq('id', diaryId).select().single();
  if (upErr) throw new Error(`diaryAction: edit failed — ${upErr.message}`);

  const { error: evErr } = await supabase.from('claim_events').insert({
    claim_id: diary.claim_id, type: 'action_edited', timestamp: patch.updated_at,
    data: { diary_id: diaryId, diary_type: diary.diary_type, changes, actor: actorEmail || null },
  });
  if (evErr) logger.error({ msg: 'editAction: event insert failed', err: evErr.message });
  const { error: auErr } = await supabase.from('audit_log').insert({
    action: 'action_edited', resource_type: 'diary', resource_id: diaryId,
    description: `${diary.diary_type} edited: ${Object.keys(changes).join(', ')}`,
    new_value: changes, actor: actorEmail || null, created_at: patch.updated_at,
  });
  if (auErr) logger.error({ msg: 'editAction: audit insert failed', err: auErr.message });

  return updated;
}

module.exports = {
  completeAction,
  declineAction,
  editAction,
  previewAftermath,
  AFTERMATH_RULES,
  STALE_COMPLETING_MS,
  _validActions,
};
