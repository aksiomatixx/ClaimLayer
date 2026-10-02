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
 * ATOMICITY + IDEMPOTENCY (Finding 5; ADR-0006):
 *
 *   - The whole decision is ONE unit of work: the diary claim, notices
 *     and their delivery channels, successor diaries, outbox rows,
 *     events, audit record, ledger entry, status transition and the
 *     completed flip commit together. A failure in any step rolls all of
 *     it back — the diary is NEVER completed on partial aftermath — and
 *     the failure itself is recorded in a separate small unit.
 *   - completeAction CLAIMS the diary inside the unit with a conditional
 *     update (open → completing). Two concurrent completions cannot both
 *     run the aftermath; the loser gets "Diary is not open".
 *   - External write-back (FileHandler) is enqueued in the outbox inside
 *     the unit and dispatched only after it commits.
 *   - Re-runs are idempotent: notices carry source_diary_id and
 *     successors carry an idempotency key. A 'completing' diary older
 *     than STALE_COMPLETING_MS (left by a crash in the non-transactional
 *     compatibility mode, or by pre-ADR-0006 code) can be re-claimed.
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
const auditLedger  = require('./auditLedgerService');
const { runInTransaction, isTransactional } = require('../db/unitOfWork');

const STALE_COMPLETING_MS = 10 * 60 * 1000;

function _rid(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

class DiaryNotOpenError extends Error {
  constructor() { super('Diary is not open'); }
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
  // Initial compensability posture (corrected model, per the licensed
  // adjuster): on claim knowledge / claim form receipt the adjuster must
  // ACCEPT, DENY, or DELAY within 14 calendar days. Only a DELAY inside
  // that window creates the 90-day decision diary — anchored to claim
  // form receipt, the LC §5402 presumption date. Accept/deny within 14
  // days means the 90-day diary never exists.
  // REGULATORY-PENDING: the controlling sections for the 14-day
  // accept/deny/delay-notice requirement and the LC §5402 90-day
  // presumption are NOT committed under docs/regulatory/ — citations
  // here are carried from existing repo copy and remain PENDING
  // verification against a committed source.
  COMPENSABILITY_NOTICE_DUE: {
    decisions: {
      accept: {
        describe: 'Accept the claim',
        requires_note: true,
        notices: [{ type: 'claim_accepted' }],
        successors: [{ diary_type: 'TD_PAYMENT_SETUP', due_days: 3, priority: 'HIGH',
                       notes: 'Claim accepted — set up TD benefits if the worker is losing time.' }],
        status_to: 'accepted',
        ai_link: 'compensability',
      },
      deny: {
        describe: 'Deny the claim (licensed-human-only action)',
        requires_note: true,
        notices: [{ type: 'claim_denied' }],
        successors: [],
        status_to: 'denied',
        ai_link: 'compensability',
      },
      delay: {
        describe: 'Delay the decision — the delay notice issues and the LC §5402 90-day clock sets the final decision diary',
        requires_note: true,
        // Delay is only lawful INSIDE the initial 14-day window: past
        // the parent diary's statutory deadline the delay-notice path is
        // gone and only accept/deny remain.
        window: 'statutory_deadline',
        notices: [{ type: 'claim_delay' }],
        // The successor lands ON the presumption date: 90 calendar days
        // from claim form receipt (claims.filed_at), immutable.
        successors: [{ diary_type: 'COMPENSABILITY_DECISION_DUE', priority: 'CRITICAL',
                       notes: 'Delayed within the 14-day window — final accept/deny due by the LC §5402 presumption date (90 calendar days from claim form receipt).',
                       due_basis: { anchor: 'claim_form_receipt', days: 90, cite: 'LC §5402' } }],
        ai_link: 'compensability',
      },
    },
  },
  // The post-delay final decision. Delay is no longer available here:
  // the presumption date cannot be moved.
  COMPENSABILITY_DECISION_DUE: {
    decisions: {
      accept: {
        describe: 'Accept the claim',
        requires_note: true,
        notices: [{ type: 'claim_accepted' }],
        successors: [{ diary_type: 'TD_PAYMENT_SETUP', due_days: 3, priority: 'HIGH',
                       notes: 'Claim accepted — set up TD benefits if the worker is losing time.' }],
        status_to: 'accepted',
        ai_link: 'compensability',
      },
      deny: {
        describe: 'Deny the claim (licensed-human-only action)',
        requires_note: true,
        notices: [{ type: 'claim_denied' }],
        successors: [],
        status_to: 'denied',
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

/**
 * Window gating: a decision marked `window: 'statutory_deadline'` is
 * only available through the parent diary's statutory deadline (the day
 * itself included). Past it the action is invalid — e.g. a
 * compensability DELAY after day 14 cannot retroactively start the
 * delay-notice path; only accept/deny remain.
 */
function _windowClosed(diary, outcome) {
  if (outcome?.window !== 'statutory_deadline' || !diary.statutory_deadline) return false;
  const today = new Date().toISOString().split('T')[0];
  return today > diary.statutory_deadline;
}

function _openActions(diary) {
  return _validActions(diary.diary_type).filter(action =>
    !_windowClosed(diary, _resolveOutcome(diary.diary_type, action)));
}

// ── Preview (dry run for the drawer) ─────────────────────────────────────────

async function previewAftermath(diaryId) {
  const { data: diary, error } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
  if (error || !diary) throw new Error(`Diary not found: ${diaryId}`);

  // Actions whose statutory window has closed are not previewed — the
  // drawer must only offer what the server will accept.
  const closed = _validActions(diary.diary_type)
    .filter(a => _windowClosed(diary, _resolveOutcome(diary.diary_type, a)));

  const actions = _openActions(diary).map(action => {
    const o = _resolveOutcome(diary.diary_type, action);
    return {
      action,
      describe: o.describe,
      requires_note: !!o.requires_note,
      will: [
        'Complete this diary and document the decision',
        ...(o.requires_note ? ['Record your decision rationale (required — validated server-side)'] : []),
        ...(o.ai_link ? [`Link your decision to the ${o.ai_link} AI recommendation in the audit trail`] : []),
        ...o.notices.map(n => `Generate + queue the "${n.type}" statutory notice (attorney copy if represented)`),
        ...o.successors.map(s => s.due_basis
          ? `Set the next diary: ${s.diary_type} due ON the ${s.due_basis.cite} presumption date (${s.due_basis.days} calendar days from claim form receipt; ${s.priority})`
          : `Set the next diary: ${s.diary_type} due in ${s.due_days} days (${s.priority}${s.ceiling ? `; capped at the ${s.ceiling.cite} statutory deadline` : ''})`),
        ...(o.status_to ? [`Transition the claim to "${o.status_to}" (WCIS reporting fires automatically)`] : []),
      ],
    };
  });
  return {
    diary_id: diaryId, diary_type: diary.diary_type, actions,
    ...(closed.length ? {
      window_closed: closed.map(a => ({
        action: a,
        reason: `the ${diary.statutory_deadline} statutory deadline has passed`,
      })),
    } : {}),
  };
}

// ── Claiming (the concurrency gate) ──────────────────────────────────────────

/**
 * Claim a diary for a decision workflow, inside the unit: open →
 * completing via conditional update (in PostgreSQL the update also takes
 * the row lock, so a concurrent claimant waits and then finds the diary
 * no longer open). A stale 'completing' is reclaimable after
 * STALE_COMPLETING_MS — the idempotency keys on notices/successors make
 * the re-run safe.
 */
async function _claimDiary(tx, diary) {
  const now = new Date().toISOString();

  if (diary.status === 'open') {
    const rows = await tx.update('diaries', { status: 'completing', updated_at: now },
      { id: diary.id, status: 'open' });
    return rows.length > 0;
  }

  if (diary.status === 'completing' &&
      diary.updated_at && (Date.now() - Date.parse(diary.updated_at)) > STALE_COMPLETING_MS) {
    const rows = await tx.update('diaries', { status: 'completing', updated_at: now },
      { id: diary.id, status: 'completing', updated_at: diary.updated_at });
    if (rows.length > 0) {
      logger.warn({ msg: 'diaryAction: reclaimed stale completing diary', diaryId: diary.id });
      return true;
    }
  }

  return false;
}

/**
 * After a failed decision unit: record the failure (append-only) and make
 * sure the diary is not left claimed. In PostgreSQL the unit already
 * rolled back, so the diary is open again; in the non-transactional
 * compatibility mode it is released here.
 */
async function _recordFailure(diary, failure, eventType) {
  try {
    await runInTransaction({ label: 'diary.decision_failed' }, async (tx) => {
      if (!isTransactional()) {
        await tx.update('diaries', { status: 'open', updated_at: new Date().toISOString() },
          { id: diary.id, status: 'completing' });
      }
      await tx.insert('claim_events', {
        claim_id: diary.claim_id, type: eventType, timestamp: new Date().toISOString(),
        data: { diary_id: diary.id, diary_type: diary.diary_type, error: failure.message, rolled_back: true },
      });
    });
  } catch (e) {
    logger.error({ msg: 'diaryAction: could not record the failed decision', diaryId: diary.id, err: e.message, originalErr: failure.message });
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

  // Statutory-window gate: an action whose window closed with the
  // diary's statutory deadline is rejected outright — e.g. delay after
  // the 14-day compensability deadline. Only the still-lawful paths
  // remain valid.
  if (_windowClosed(diary, outcome)) {
    throw new Error(
      `Action "${action}" is no longer available for ${diary.diary_type} — ` +
      `the ${diary.statutory_deadline} statutory deadline has passed. ` +
      `Valid: ${_openActions(diary).join(', ')}`);
  }

  // Consequential decisions (compensability accept/deny/delay) require
  // a documented rationale — validated here, server-side, before the
  // diary is even claimed.
  if (outcome.requires_note && !String(note || '').trim()) {
    throw new Error(
      `A decision rationale is required for "${action}" on ${diary.diary_type} — consequential decisions are documented, never bare.`);
  }

  const claimId = diary.claim_id;
  const now = new Date().toISOString();
  const actor = { type: 'human', id: actorEmail || 'unattributed', role: null };

  let result;
  try {
    result = await runInTransaction({ actorId: actor.id, label: `diary.complete:${diary.diary_type}` }, async (tx) => {
      // The concurrency gate: only one completion may claim the diary.
      if (!(await _claimDiary(tx, diary))) throw new DiaryNotOpenError();

      const noticesGenerated = [];
      const successors = [];
      const escalations = [];
      let statusTransition = null;

      // 0. Status transition first: it carries the business validation
      //    (an invalid transition fails the decision before anything is
      //    generated). Its WCIS jobs join this unit.
      if (outcome.status_to) {
        const claimService = require('./claimService');
        await claimService.updateStatus(claimId, outcome.status_to, actorEmail || 'aftermath-automation', { tx });
        statusTransition = outcome.status_to;
      }

      // 1. Generate + queue the required notices (idempotent on
      //    source_diary_id — a re-run never duplicates them).
      const noticeTemplates = require('./noticeTemplateService');
      const delivery = require('./noticeDeliveryService');
      const priorNotices = await tx.select('benefit_notices', { source_diary_id: diaryId });
      const priorTypes = new Set(priorNotices.map(n => n.notice_type));

      for (const n of outcome.notices) {
        if (priorTypes.has(n.type)) {
          for (const row of priorNotices.filter(p => p.notice_type === n.type)) {
            noticesGenerated.push({ id: row.id, type: row.notice_type, audience: row.audience, status: row.status });
          }
          continue;
        }
        const { notices } = await noticeTemplates.generateNotice(
          n.type, claimId,
          { ...(n.ctx || {}), decision_note: note, event_date: now.split('T')[0] },
          { source_diary_id: diaryId, tx },
        );
        for (const row of notices) {
          const queued = await delivery.queueNotice(row.id, { tx });
          noticesGenerated.push({ id: row.id, type: row.notice_type, audience: row.audience, status: queued.status });
        }
      }

      // 2. Set the successor diaries (idempotent on the successor key).
      //    Successors with a statutory ceiling are capped at the immutable
      //    original deadline; a deadline already in the past produces a
      //    CRITICAL escalation instead of a successor (Finding 6).
      for (const s of outcome.successors) {
        const idemKey = `succ:${diaryId}:${s.diary_type}`;
        const existing = await tx.select('diaries', { idempotency_key: idemKey });
        if (existing.length > 0) {
          successors.push(existing[0]);
          continue;
        }

        let dueDate = s.due_days != null ? _addDays(s.due_days) : null;
        let statutoryDeadline = null;
        if (s.due_basis) {
          // The successor lands ON the statutory date (e.g. the LC §5402
          // presumption: 90 calendar days from claim form receipt). The
          // date is immutable — derived from the claim record, never from
          // when the delay decision happened to be made.
          statutoryDeadline = await _deriveAnchorDate(tx, claimId, s.due_basis);
          if (!statutoryDeadline) {
            throw new Error(`successor ${s.diary_type}: cannot derive the ${s.due_basis.cite} date — claim has no receipt date`);
          }
          dueDate = statutoryDeadline;
        } else if (s.ceiling) {
          statutoryDeadline = diary.statutory_deadline ||
            await _deriveCeiling(tx, claimId, s.ceiling);
        }
        if (statutoryDeadline) {
          const today = new Date().toISOString().split('T')[0];
          if (statutoryDeadline < today) {
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
              notes: `${(s.due_basis || s.ceiling).cite} statutory deadline ${statutoryDeadline} has PASSED — ` +
                     `the ${s.diary_type} decision cannot be delayed further. ` +
                     'Presumption/penalty exposure: resolve immediately.',
              created_at: now,
            };
            await tx.insert('diaries', esc);
            escalations.push(esc);
            await tx.insert('claim_events', {
              id: _rid('evt'),
              claim_id: claimId, type: 'statutory_deadline_breached', timestamp: now,
              data: { diary_id: diaryId, diary_type: s.diary_type, cite: (s.due_basis || s.ceiling).cite,
                      statutory_deadline: statutoryDeadline, escalation_diary_id: esc.id },
            });
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
        await tx.insert('diaries', row);
        successors.push(row);
      }

      // 3. System-of-record write-back through the transactional outbox —
      //    rows inside this unit, dispatched after it commits.
      const outboxIds = await _enqueueWriteBack(tx, claimId, diary, outcome, { action, note }, actorEmail);

      // 4. Document the decision.
      await tx.insert('claim_events', {
        id: _rid('evt'),
        claim_id: claimId, type: 'action_completed', timestamp: now,
        data: { diary_id: diaryId, diary_type: diary.diary_type, action: action || 'complete', note: note || null, actor: actorEmail || null },
      });
      await tx.insert('audit_log', {
        action: 'action_completed', resource_type: 'diary', resource_id: diaryId,
        description: `${diary.diary_type}: ${outcome.describe}${note ? ` — ${note}` : ''}`,
        actor: actorEmail || null, created_at: now,
      });

      // 5. Completing → completed with the decision on it.
      const finalized = await tx.update('diaries', {
        status: 'completed',
        completed_at: now,
        completed_by: actorEmail || null,
        decision_action: action || 'complete',
        decision_note: note || null,
        updated_at: new Date().toISOString(),
      }, { id: diaryId, status: 'completing' });
      if (finalized.length === 0) throw new Error('finalize failed: claim was lost');

      // 6. The immutable record of the decision, in the same unit.
      await auditLedger.append({
        actor,
        action:   'diary.action_completed',
        entity:   { type: 'diary', id: diaryId },
        claimId,
        payload:  {
          diary_type:          diary.diary_type,
          action:              action || 'complete',
          rationale:           note || null,
          status_transition:   statusTransition,
          notices_generated:   noticesGenerated.length,
          successor_diaries:   successors.map(sd => sd.diary_type),
        },
        evidence: [{ type: 'diary', id: diaryId },
                   ...(diary.source_document_id ? [{ type: 'document', id: diary.source_document_id }] : [])],
      }, { tx });

      // After commit: link the human decision to the AI recommendation it
      // accepted/overrode, and dispatch the outbox opportunistically.
      if (outcome.ai_link) {
        tx.afterCommit(async () => {
          try {
            const aid = require('./aiDecisionsService');
            await aid.linkHumanDecision(claimId, outcome.ai_link, {
              // Decision AND its rationale ride into the audit trail together.
              human_decision: `${diary.diary_type}:${action}${note ? ` — ${note}` : ''}`,
              human_decision_at: now,
              human_decision_by: actorEmail || null,
            });
          } catch (e) {
            logger.warn({ msg: 'completeAction: ai link failed (non-fatal)', err: e.message });
          }
        });
      }
      tx.afterCommit(() => _dispatchOutbox(outboxIds));

      return {
        diary_id: diaryId,
        diary_type: diary.diary_type,
        action: action || 'complete',
        notices_generated: noticesGenerated,
        successor_diaries: successors.map(sd => ({ id: sd.id, diary_type: sd.diary_type, due_date: sd.due_date, statutory_deadline: sd.statutory_deadline || null })),
        escalations: escalations.map(e => ({ id: e.id, diary_type: e.diary_type, due_date: e.due_date, statutory_deadline: e.statutory_deadline })),
        status_transition: statusTransition,
      };
    });
  } catch (e) {
    if (e instanceof DiaryNotOpenError) throw new Error('Diary is not open');
    logger.error({ msg: 'completeAction: aftermath failed — rolled back', diaryId, err: e.message });
    await _recordFailure(diary, e, 'action_completion_failed');
    throw new Error(`Action not completed — required aftermath failed and was rolled back: ${e.message}`);
  }
  return result;
}

/**
 * Derive a fixed statutory date from a due_basis spec. The
 * claim_form_receipt anchor is claims.filed_at (when the claim form
 * was received and the claim filed) — falling back to created_at for
 * rows that predate filed_at. Immutable by construction.
 */
async function _deriveAnchorDate(tx, claimId, dueBasis) {
  if (dueBasis.anchor !== 'claim_form_receipt') return null;
  const claim = await tx.selectOne('claims', { id: claimId });
  if (!claim) return null;
  const anchor = claim.filed_at || claim.created_at;
  if (!anchor) return null;
  const d = new Date(anchor);
  d.setUTCDate(d.getUTCDate() + dueBasis.days);
  return d.toISOString().split('T')[0];
}

/**
 * Derive a successor's statutory ceiling when the parent diary does not
 * carry one (legacy rows): doi_plus_days anchors to the claim's
 * date_of_injury — immutable, so the ceiling cannot drift.
 */
async function _deriveCeiling(tx, claimId, ceiling) {
  if (ceiling.basis !== 'doi_plus_days') return null;
  const claim = await tx.selectOne('claims', { id: claimId });
  if (!claim?.date_of_injury) return null;
  const d = new Date(`${claim.date_of_injury}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ceiling.days);
  return d.toISOString().split('T')[0];
}

// ── System-of-record write-back (outbox rows) ────────────────────────────────

async function _enqueueWriteBack(tx, claimId, diary, outcome, decision, actorEmail) {
  const claim = await tx.selectOne('claims', { id: claimId });
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
  const rows = await outbox.enqueue(entries, { tx });
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

  const now = new Date().toISOString();
  try {
    await runInTransaction({ actorId: actorEmail || 'unattributed', label: 'diary.decline' }, async (tx) => {
      if (!(await _claimDiary(tx, diary))) throw new DiaryNotOpenError();

      const outboxIds = await _enqueueWriteBack(tx, diary.claim_id, diary,
        { describe: 'Action declined' }, { action: 'declined', note: reason }, actorEmail);

      await tx.insert('claim_events', {
        id: _rid('evt'),
        claim_id: diary.claim_id, type: 'action_declined', timestamp: now,
        data: { diary_id: diaryId, diary_type: diary.diary_type, reason, actor: actorEmail || null },
      });
      await tx.insert('audit_log', {
        action: 'action_declined', resource_type: 'diary', resource_id: diaryId,
        description: `${diary.diary_type} declined: ${reason}`,
        actor: actorEmail || null, created_at: now,
      });

      const finalized = await tx.update('diaries', {
        status: 'cancelled',
        completed_at: now,
        completed_by: actorEmail || null,
        decision_action: 'declined',
        decision_note: reason,
        updated_at: new Date().toISOString(),
      }, { id: diaryId, status: 'completing' });
      if (finalized.length === 0) throw new Error('finalize failed: claim was lost');

      await auditLedger.append({
        actor:    { type: 'human', id: actorEmail || 'unattributed', role: null },
        action:   'diary.action_declined',
        entity:   { type: 'diary', id: diaryId },
        claimId:  diary.claim_id,
        payload:  { diary_type: diary.diary_type, reason },
        evidence: [{ type: 'diary', id: diaryId }],
      }, { tx });

      tx.afterCommit(() => _dispatchOutbox(outboxIds));
    });
  } catch (e) {
    if (e instanceof DiaryNotOpenError) throw new Error('Diary is not open');
    logger.error({ msg: 'declineAction: failed — rolled back', diaryId, err: e.message });
    await _recordFailure(diary, e, 'action_decline_failed');
    throw new Error(`Decline not recorded — ${e.message}`);
  }

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

  // The edit, its event and its audit record are one unit: a deadline is
  // never moved without the record of who moved it.
  const updated = await runInTransaction({ actorId: actorEmail || 'unattributed', label: 'diary.edit' }, async (tx) => {
    const [row] = await tx.update('diaries', patch, { id: diaryId, status: 'open' });
    if (!row) throw new Error('Diary is not open');
    await tx.insert('claim_events', {
      claim_id: diary.claim_id, type: 'action_edited', timestamp: patch.updated_at,
      data: { diary_id: diaryId, diary_type: diary.diary_type, changes, actor: actorEmail || null },
    });
    await tx.insert('audit_log', {
      action: 'action_edited', resource_type: 'diary', resource_id: diaryId,
      description: `${diary.diary_type} edited: ${Object.keys(changes).join(', ')}`,
      new_value: changes, actor: actorEmail || null, created_at: patch.updated_at,
    });
    return row;
  });

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
