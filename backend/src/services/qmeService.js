'use strict';

/**
 * qmeService.js — M11 QME/AME Process Management.
 *
 * Two tracks:
 *   QME (unrepresented): DWC panel → worker strikes 2 → one remains
 *   AME (represented):   both sides agree on one doctor
 *
 * CRITICAL: Strike deadline is 10 CALENDAR days (LC §4062.2).
 *           Do NOT use addBusinessDays. Use plain date arithmetic.
 *
 * CRITICAL: No automated worker communications on AME track —
 *           attorney represented means all comms go through attorney.
 */

const { supabase } = require('./supabase');
const config = require('../config');
const logger       = require('../logger');

// ── Audit log (same pattern as noticeService) ────────────────────────────────

async function _writeAuditLog(action, resourceType, resourceId, description, newValue) {
  try {
    await supabase.from('audit_log').insert({
      action,
      resource_type: resourceType,
      resource_id:   resourceId,
      description,
      new_value:     newValue,
      user_role:     'system',
      created_at:    new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'qmeService: audit_log write failed', err: err.message, action, resourceId });
  }
}

// ── Diary creation helper ────────────────────────────────────────────────────

async function _createDiary(claimId, diaryType, dueDate, priority, notes, opts = {}) {
  const row = {
    claim_id:    claimId,
    diary_type:  diaryType,
    due_date:    dueDate,
    assigned_to: config.adjuster.email,
    priority,
    notes,
    status:      'open',
    no_snooze:   opts.noSnooze || false,
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  new Date().toISOString(),
  };

  await supabase.from('diaries').insert(row);

  // Claim event for audit trail
  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'diary_created',
    timestamp: new Date().toISOString(),
    data:      { diaryType, dueDate, priority, noSnooze: row.no_snooze },
  });

  return row;
}

// ── Close a diary by type + claim ────────────────────────────────────────────

async function _closeDiary(claimId, diaryType) {
  await supabase
    .from('diaries')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('claim_id', claimId)
    .eq('diary_type', diaryType)
    .eq('status', 'open');
}

// ── Calendar day math (NOT business days — LC §4062.2) ───────────────────────

function _addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// requestPanel
// ═════════════════════════════════════════════════════════════════════════════

async function requestPanel(claimId, specialty, adjusterNotes) {
  const now = new Date().toISOString();

  const panelRow = {
    claim_id:   claimId,
    specialty,
    track:      'qme',  // Default; AME track set via separate flow
    status:     'panel_requested',
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from('qme_panels')
    .insert(panelRow)
    .select()
    .single();

  if (error) throw new Error(`qmeService.requestPanel: ${error.message}`);

  const panel = data;

  await _createDiary(
    claimId,
    'QME_PANEL_REQUESTED',
    _addCalendarDays(now.split('T')[0], 30), // Follow-up if DWC hasn't issued panel in 30 days
    'CRITICAL',
    `QME panel requested — ${specialty}. Strike deadline will be 10 days from panel issue date. Update panel record when DWC issues panel.${adjusterNotes ? ` Notes: ${adjusterNotes}` : ''}`,
  );

  await _writeAuditLog(
    'qme_panel_requested', 'qme_panel', panel.id,
    `QME panel requested for claim ${claimId} — specialty: ${specialty}`,
    { claimId, specialty, adjusterNotes },
  );

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'qme_panel_requested',
    timestamp: now,
    data:      { panelId: panel.id, specialty },
  });

  logger.info({ msg: 'qmeService.requestPanel: complete', panelId: panel.id, claimId, specialty });

  return panel;
}

// ═════════════════════════════════════════════════════════════════════════════
// issuePanel
// ═════════════════════════════════════════════════════════════════════════════

async function issuePanel(panelId, { panelIssuedDate, doctor1, doctor2, doctor3 }) {
  const panel = await getPanel(panelId);
  if (!panel) throw new Error(`QME panel not found: ${panelId}`);
  if (panel.status !== 'panel_requested') {
    throw new Error(`Cannot issue panel in status: ${panel.status}`);
  }

  // 10 CALENDAR days — LC §4062.2. NOT business days.
  const strikeDeadline = _addCalendarDays(panelIssuedDate, 10);

  const updates = {
    panel_issued_date: panelIssuedDate,
    strike_deadline:   strikeDeadline,
    doctor_1_name:     doctor1.name,
    doctor_1_npi:      doctor1.npi,
    doctor_1_address:  doctor1.address || null,
    doctor_2_name:     doctor2.name,
    doctor_2_npi:      doctor2.npi,
    doctor_2_address:  doctor2.address || null,
    doctor_3_name:     doctor3.name,
    doctor_3_npi:      doctor3.npi,
    doctor_3_address:  doctor3.address || null,
    status:            'panel_issued',
    updated_at:        new Date().toISOString(),
  };

  const { error } = await supabase
    .from('qme_panels')
    .update(updates)
    .eq('id', panelId);

  if (error) throw new Error(`qmeService.issuePanel: ${error.message}`);

  // Close the panel_requested follow-up diary
  await _closeDiary(panel.claim_id, 'QME_PANEL_REQUESTED');

  // CRITICAL strike deadline diary — no_snooze: true
  await _createDiary(
    panel.claim_id,
    'QME_STRIKE_DEADLINE',
    strikeDeadline,
    'CRITICAL',
    `Strike deadline: ${strikeDeadline}. Worker must strike 2 of 3 panel doctors. CANNOT BE MISSED. Panel: ${doctor1.name}, ${doctor2.name}, ${doctor3.name}.`,
    { noSnooze: true },
  );

  await _writeAuditLog(
    'qme_panel_issued', 'qme_panel', panelId,
    `QME panel issued — strike deadline: ${strikeDeadline}`,
    { panelIssuedDate, strikeDeadline, doctors: [doctor1.name, doctor2.name, doctor3.name] },
  );

  await supabase.from('claim_events').insert({
    claim_id:  panel.claim_id,
    type:      'qme_panel_issued',
    timestamp: new Date().toISOString(),
    data:      { panelId, strikeDeadline, panelIssuedDate },
  });

  logger.info({ msg: 'qmeService.issuePanel: complete', panelId, strikeDeadline });

  return getPanel(panelId);
}

// ═════════════════════════════════════════════════════════════════════════════
// recordStrikes
// ═════════════════════════════════════════════════════════════════════════════

async function recordStrikes(panelId, { strike1Npi, strike2Npi }) {
  const panel = await getPanel(panelId);
  if (!panel) throw new Error(`QME panel not found: ${panelId}`);
  if (panel.status !== 'panel_issued') {
    throw new Error(`Cannot record strikes in status: ${panel.status}`);
  }

  // Validate NPIs are in the panel
  const panelNpis = [panel.doctor_1_npi, panel.doctor_2_npi, panel.doctor_3_npi];
  if (!panelNpis.includes(strike1Npi)) {
    throw new Error(`Strike 1 NPI "${strike1Npi}" is not in the panel`);
  }
  if (!panelNpis.includes(strike2Npi)) {
    throw new Error(`Strike 2 NPI "${strike2Npi}" is not in the panel`);
  }
  if (strike1Npi === strike2Npi) {
    throw new Error('Cannot strike the same doctor twice');
  }

  // Derive remaining doctor
  const struckNpis = [strike1Npi, strike2Npi];
  const remaining  = panelNpis.find(npi => !struckNpis.includes(npi));

  // Find the doctor details for the selected doctor
  let selectedName    = null;
  let selectedAddress = null;
  for (const i of [1, 2, 3]) {
    if (panel[`doctor_${i}_npi`] === remaining) {
      selectedName    = panel[`doctor_${i}_name`];
      selectedAddress = panel[`doctor_${i}_address`];
      break;
    }
  }

  const updates = {
    strike_1_npi:     strike1Npi,
    strike_2_npi:     strike2Npi,
    selected_npi:     remaining,
    selected_name:    selectedName,
    selected_address: selectedAddress,
    status:           'doctor_selected',
    updated_at:       new Date().toISOString(),
  };

  const { error } = await supabase
    .from('qme_panels')
    .update(updates)
    .eq('id', panelId);

  if (error) throw new Error(`qmeService.recordStrikes: ${error.message}`);

  // Close the strike deadline diary
  await _closeDiary(panel.claim_id, 'QME_STRIKE_DEADLINE');

  // New diary: schedule appointment
  await _createDiary(
    panel.claim_id,
    'QME_SCHEDULE_APPOINTMENT',
    _addCalendarDays(new Date().toISOString().split('T')[0], 14),
    'HIGH',
    `QME doctor selected: ${selectedName}. Schedule appointment.`,
  );

  await _writeAuditLog(
    'qme_strikes_recorded', 'qme_panel', panelId,
    `Strikes recorded — selected doctor: ${selectedName} (NPI: ${remaining})`,
    { strike1Npi, strike2Npi, selectedNpi: remaining, selectedName },
  );

  await supabase.from('claim_events').insert({
    claim_id:  panel.claim_id,
    type:      'qme_strikes_recorded',
    timestamp: new Date().toISOString(),
    data:      { panelId, strike1Npi, strike2Npi, selectedNpi: remaining, selectedName },
  });

  logger.info({ msg: 'qmeService.recordStrikes: complete', panelId, selectedName, selectedNpi: remaining });

  return getPanel(panelId);
}

// ═════════════════════════════════════════════════════════════════════════════
// scheduleAppointment
// ═════════════════════════════════════════════════════════════════════════════

async function scheduleAppointment(panelId, { appointmentDate }) {
  const panel = await getPanel(panelId);
  if (!panel) throw new Error(`QME panel not found: ${panelId}`);
  if (panel.status !== 'doctor_selected') {
    throw new Error(`Cannot schedule appointment in status: ${panel.status}`);
  }

  // Report due 30 calendar days after appointment (CCR §35)
  const reportDueDate = _addCalendarDays(appointmentDate, 30);

  const updates = {
    appointment_date: appointmentDate,
    status:           'appointment_scheduled',
    report_due_date:  reportDueDate,
    updated_at:       new Date().toISOString(),
  };

  const { error } = await supabase
    .from('qme_panels')
    .update(updates)
    .eq('id', panelId);

  if (error) throw new Error(`qmeService.scheduleAppointment: ${error.message}`);

  // Close the schedule appointment diary
  await _closeDiary(panel.claim_id, 'QME_SCHEDULE_APPOINTMENT');

  // Report due diary
  await _createDiary(
    panel.claim_id,
    'QME_REPORT_DUE',
    reportDueDate,
    'HIGH',
    `QME report due: ${reportDueDate}. If not received, follow up with ${panel.selected_name || 'selected doctor'}.`,
  );

  await _writeAuditLog(
    'qme_appointment_scheduled', 'qme_panel', panelId,
    `QME appointment scheduled: ${appointmentDate}. Report due: ${reportDueDate}`,
    { appointmentDate, reportDueDate },
  );

  await supabase.from('claim_events').insert({
    claim_id:  panel.claim_id,
    type:      'qme_appointment_scheduled',
    timestamp: new Date().toISOString(),
    data:      { panelId, appointmentDate, reportDueDate },
  });

  logger.info({ msg: 'qmeService.scheduleAppointment: complete', panelId, appointmentDate, reportDueDate });

  return getPanel(panelId);
}

// ═════════════════════════════════════════════════════════════════════════════
// recordReportReceived
// ═════════════════════════════════════════════════════════════════════════════

async function recordReportReceived(panelId) {
  const panel = await getPanel(panelId);
  if (!panel) throw new Error(`QME panel not found: ${panelId}`);
  if (!['appointment_scheduled', 'report_pending'].includes(panel.status)) {
    throw new Error(`Cannot record report in status: ${panel.status}`);
  }

  const now = new Date().toISOString();

  const { error } = await supabase
    .from('qme_panels')
    .update({ report_received_at: now, status: 'report_received', updated_at: now })
    .eq('id', panelId);

  if (error) throw new Error(`qmeService.recordReportReceived: ${error.message}`);

  // Close report due diary
  await _closeDiary(panel.claim_id, 'QME_REPORT_DUE');

  // Review diary
  await _createDiary(
    panel.claim_id,
    'QME_REPORT_REVIEW',
    _addCalendarDays(now.split('T')[0], 7),
    'HIGH',
    'QME report received. Review for: permanent disability rating, apportionment, future medical, work restrictions, supplemental report needs.',
  );

  await _writeAuditLog(
    'qme_report_received', 'qme_panel', panelId,
    'QME report received — queued for adjuster review and AI supplemental evaluation',
    { receivedAt: now },
  );

  await supabase.from('claim_events').insert({
    claim_id:  panel.claim_id,
    type:      'qme_report_received',
    timestamp: now,
    data:      { panelId },
  });

  logger.info({ msg: 'qmeService.recordReportReceived: complete', panelId });

  // Trigger supplemental report evaluation (fire-and-forget)
  setImmediate(() => {
    try {
      const supplementalRequestService = require('./supplementalRequestService');
      supplementalRequestService.evaluateQmeReport(panelId).catch(err =>
        logger.error({ msg: 'qmeService: supplemental evaluation failed', panelId, err: err.message }),
      );
    } catch (err) {
      logger.error({ msg: 'qmeService: supplementalRequestService not loaded', err: err.message });
    }
  });

  return getPanel(panelId);
}

// ═════════════════════════════════════════════════════════════════════════════
// Read operations
// ═════════════════════════════════════════════════════════════════════════════

async function getPanel(panelId) {
  const { data, error } = await supabase
    .from('qme_panels')
    .select('*')
    .eq('id', panelId)
    .single();

  if (error || !data) return null;
  return data;
}

async function getPanelsForClaim(claimId) {
  const { data, error } = await supabase
    .from('qme_panels')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ msg: 'qmeService.getPanelsForClaim: query failed', err: error.message });
    throw new Error(error.message);
  }

  return data || [];
}

// ── Exported for tests ───────────────────────────────────────────────────────
module.exports = {
  requestPanel,
  issuePanel,
  recordStrikes,
  scheduleAppointment,
  recordReportReceived,
  getPanel,
  getPanelsForClaim,
  _addCalendarDays,
  _createDiary,
};
