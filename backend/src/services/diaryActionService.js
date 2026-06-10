'use strict';

/**
 * Action-Queue Aftermath Automation (Tier 1).
 *
 * The outbound half of the inversion's operating contract: when the
 * adjuster completes a queued action, everything after the decision
 * executes itself —
 *
 *   1. the diary is completed with the decision recorded,
 *   2. the decision is documented (audit log + claim event + linkage to
 *      the AI recommendation it accepted or overrode),
 *   3. the statutory notices the decision requires are generated and
 *      queued for delivery (Notice Library + Delivery Orchestration),
 *   4. the next deadline diaries are set,
 *   5. claim status transitions fire where the decision implies one
 *      (which in turn fires the already-wired WCIS triggers).
 *
 * AFTERMATH_RULES is deterministic policy-in-code, keyed by
 * (diary_type, decision.action). previewAftermath() renders the same
 * rules as a dry run so the drawer can show the adjuster exactly what
 * completing an action will do — before they do it.
 */

const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');

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
        successors: [{ diary_type: 'COMPENSABILITY_DECISION_DUE', due_days: 30, priority: 'CRITICAL',
                       notes: 'Delayed decision — LC §5402 90-day window still running.' }],
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
  const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (!diary) throw new Error(`Diary not found: ${diaryId}`);

  const actions = _validActions(diary.diary_type).map(action => {
    const o = _resolveOutcome(diary.diary_type, action);
    return {
      action,
      describe: o.describe,
      will: [
        'Complete this diary and document the decision',
        ...(o.ai_link ? [`Link your decision to the ${o.ai_link} AI recommendation in the audit trail`] : []),
        ...o.notices.map(n => `Generate + queue the "${n.type}" statutory notice (attorney copy if represented)`),
        ...o.successors.map(s => `Set the next diary: ${s.diary_type} due in ${s.due_days} days (${s.priority})`),
        ...(o.status_to ? [`Transition the claim to "${o.status_to}" (WCIS reporting fires automatically)`] : []),
      ],
    };
  });
  return { diary_id: diaryId, diary_type: diary.diary_type, actions };
}

// ── Completion ────────────────────────────────────────────────────────────────

async function completeAction(diaryId, { action, note } = {}, actorEmail) {
  const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (!diary) throw new Error(`Diary not found: ${diaryId}`);
  if (diary.status !== 'open') throw new Error('Diary is not open');

  const outcome = _resolveOutcome(diary.diary_type, action || 'complete');
  if (!outcome) {
    throw new Error(
      `Unknown action "${action}" for ${diary.diary_type}. Valid: ${_validActions(diary.diary_type).join(', ')}`);
  }

  const claimId = diary.claim_id;
  const now = new Date().toISOString();

  // 1. Complete the diary with the decision on it.
  await supabase.from('diaries').update({
    status: 'completed',
    completed_at: now,
    completed_by: actorEmail || null,
    decision_action: action || 'complete',
    decision_note: note || null,
    updated_at: now,
  }).eq('id', diaryId);

  // 2. Document the decision.
  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'action_completed', timestamp: now,
    data: { diary_id: diaryId, diary_type: diary.diary_type, action: action || 'complete', note: note || null, actor: actorEmail || null },
  });
  await supabase.from('audit_log').insert({
    action: 'action_completed', resource_type: 'diary', resource_id: diaryId,
    description: `${diary.diary_type}: ${outcome.describe}${note ? ` — ${note}` : ''}`,
    actor: actorEmail || null, created_at: now,
  });

  // 2b. System-of-record write-back (non-fatal): the decision note goes to
  // FileHandler — ClaimLayer is a layer, the ledger stays the ledger — and
  // the mirrored FileHandler diary is completed when one exists.
  await _writeBackToSystemOfRecord(claimId, diary, outcome, { action, note }, actorEmail);

  // 2c. Link the human decision to the AI recommendation it accepted/overrode.
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

  // 3. Generate + queue the required notices.
  const noticesGenerated = [];
  for (const n of outcome.notices) {
    try {
      const noticeTemplates = require('./noticeTemplateService');
      const delivery = require('./noticeDeliveryService');
      const { notices } = await noticeTemplates.generateNotice(
        n.type, claimId, { ...(n.ctx || {}), ...( { decision_note: note } ), event_date: now.split('T')[0] });
      for (const row of notices) {
        await delivery.queueNotice(row.id);
        noticesGenerated.push({ id: row.id, type: row.notice_type, audience: row.audience, status: row.status });
      }
    } catch (e) {
      // A notice failure must not un-complete the decision — it surfaces
      // as a CRITICAL diary instead of silently disappearing.
      logger.error({ msg: 'completeAction: notice generation failed', notice: n.type, err: e.message });
      await supabase.from('diaries').insert({
        id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        claim_id: claimId, diary_type: 'NOTICE_GENERATION_FAILED',
        due_date: _addDays(1), assigned_to: config.adjuster.email,
        priority: 'CRITICAL', status: 'open',
        notes: `Failed to generate "${n.type}" after ${diary.diary_type}: ${e.message}`,
        created_at: now,
      });
    }
  }

  // 4. Set the successor diaries.
  const successors = [];
  for (const s of outcome.successors) {
    const row = {
      id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      claim_id: claimId, diary_type: s.diary_type,
      due_date: _addDays(s.due_days), assigned_to: config.adjuster.email,
      priority: s.priority, status: 'open', notes: s.notes,
      created_at: now,
    };
    await supabase.from('diaries').insert(row);
    successors.push(row);
  }

  // 5. Status transition (fires the already-wired WCIS triggers).
  let statusTransition = null;
  if (outcome.status_to) {
    const claimService = require('./claimService');
    try {
      await claimService.updateStatus(claimId, outcome.status_to, actorEmail || 'aftermath-automation');
      statusTransition = outcome.status_to;
    } catch (e) {
      logger.error({ msg: 'completeAction: status transition failed', to: outcome.status_to, err: e.message });
      throw new Error(`Decision recorded but status transition failed: ${e.message}`);
    }
  }

  return {
    diary_id: diaryId,
    diary_type: diary.diary_type,
    action: action || 'complete',
    notices_generated: noticesGenerated,
    successor_diaries: successors.map(s => ({ id: s.id, diary_type: s.diary_type, due_date: s.due_date })),
    status_transition: statusTransition,
  };
}

async function _writeBackToSystemOfRecord(claimId, diary, outcome, decision, actorEmail) {
  try {
    const { data: claim } = await supabase
      .from('claims').select('filehandler_id').eq('id', claimId).single();
    if (!claim?.filehandler_id) return;
    const filehandler = require('./filehandler');
    const noteText =
      `[ClaimLayer] ${diary.diary_type} — ${outcome.describe}` +
      `${decision.note ? `: ${decision.note}` : ''} (action: ${decision.action || 'complete'})`;
    await filehandler.addNote(claim.filehandler_id, noteText, actorEmail || 'ADJUSTER');
    if (diary.fh_diary_id) {
      await filehandler.completeDiary(
        claim.filehandler_id, diary.fh_diary_id,
        decision.note || outcome.describe, actorEmail || 'ADJUSTER');
    }
  } catch (e) {
    // Write-back failures never block the decision; the sync badge and
    // ledger reconciliation surface the gap.
    logger.warn({ msg: 'completeAction: system-of-record write-back failed (non-fatal)', claimId, err: e.message });
  }
}

/**
 * Decline a queued action: the licensed human disagrees with the prepared
 * decision. The diary is cancelled WITH a documented reason — no aftermath
 * runs, nothing is silently dropped.
 */
async function declineAction(diaryId, { reason } = {}, actorEmail) {
  const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (!diary) throw new Error(`Diary not found: ${diaryId}`);
  if (diary.status !== 'open') throw new Error('Diary is not open');
  if (!reason || !String(reason).trim()) {
    throw new Error('A decline reason is required — declined actions are documented, never dropped');
  }

  const now = new Date().toISOString();
  await supabase.from('diaries').update({
    status: 'cancelled',
    completed_at: now,
    completed_by: actorEmail || null,
    decision_action: 'declined',
    decision_note: reason,
    updated_at: now,
  }).eq('id', diaryId);

  await supabase.from('claim_events').insert({
    claim_id: diary.claim_id, type: 'action_declined', timestamp: now,
    data: { diary_id: diaryId, diary_type: diary.diary_type, reason, actor: actorEmail || null },
  });
  await supabase.from('audit_log').insert({
    action: 'action_declined', resource_type: 'diary', resource_id: diaryId,
    description: `${diary.diary_type} declined: ${reason}`,
    actor: actorEmail || null, created_at: now,
  });

  await _writeBackToSystemOfRecord(diary.claim_id, diary,
    { describe: 'Action declined' }, { action: 'declined', note: reason }, actorEmail);

  return { diary_id: diaryId, diary_type: diary.diary_type, status: 'cancelled', reason };
}

/**
 * Edit a queued action before deciding it: due date, priority, or notes.
 * Every edit is audited — the queue is the compliance contract, so moving
 * a deadline is itself a documented act.
 */
async function editAction(diaryId, { due_date, priority, notes } = {}, actorEmail) {
  const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (!diary) throw new Error(`Diary not found: ${diaryId}`);
  if (diary.status !== 'open') throw new Error('Diary is not open');
  if (diary.no_snooze && due_date && due_date > diary.due_date) {
    throw new Error('NO_SNOOZE_DIARY — statutory penalty diaries cannot be pushed out');
  }

  const patch = { updated_at: new Date().toISOString() };
  const changes = {};
  if (due_date)  { patch.due_date = due_date;   changes.due_date = { from: diary.due_date, to: due_date }; }
  if (priority)  { patch.priority = priority;   changes.priority = { from: diary.priority, to: priority }; }
  if (notes !== undefined) { patch.notes = notes; changes.notes = true; }
  if (Object.keys(changes).length === 0) throw new Error('Nothing to edit');

  const { data: updated } = await supabase.from('diaries')
    .update(patch).eq('id', diaryId).select().single();

  await supabase.from('claim_events').insert({
    claim_id: diary.claim_id, type: 'action_edited', timestamp: patch.updated_at,
    data: { diary_id: diaryId, diary_type: diary.diary_type, changes, actor: actorEmail || null },
  });
  await supabase.from('audit_log').insert({
    action: 'action_edited', resource_type: 'diary', resource_id: diaryId,
    description: `${diary.diary_type} edited: ${Object.keys(changes).join(', ')}`,
    new_value: changes, actor: actorEmail || null, created_at: patch.updated_at,
  });

  return updated;
}

module.exports = {
  completeAction,
  declineAction,
  editAction,
  previewAftermath,
  AFTERMATH_RULES,
  _validActions,
};
