'use strict';

/**
 * appointmentService.js — Appointment booking and confirmation.
 *
 * Orchestrates:
 *   1. Appointment record creation
 *   2. MPN acknowledgment event logging
 *   3. FileHandler diary creation
 *   4. Authorization letter generation + email (on confirmation)
 *   5. DWC-1 generation trigger (on confirmation)
 *   6. Intake progress tracking
 */

const db              = require('./db');
const filehandler     = require('./filehandler');
const pdfService      = require('./pdfService');
const logger          = require('../logger');

// ── Lazy-load to avoid circular dependency ────────────────────────────────────
function getClaimService() { return require('./claimService'); }
function getSendGrid()     { return require('./notificationService'); }

// ── logMpnAcknowledgment ──────────────────────────────────────────────────────
/**
 * Logs that the employee saw and acknowledged the MPN rights notice.
 * This is evidentiary — timestamp is the proof at WCAB.
 */
async function logMpnAcknowledgment(claimId, employeeId) {
  const claimService = getClaimService();
  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  claim.events.push({
    type:      'mpn_notice_acknowledged',
    timestamp: new Date().toISOString(),
    data:      { employeeId, method: 'portal_tap' },
  });
  // Update intake progress
  if (claim.intakeProgress) claim.intakeProgress.mpn_acknowledged = true;

  logger.info({ msg: 'appointmentService: MPN acknowledgment logged', claimId });
  return claim;
}

// ── createAppointment ─────────────────────────────────────────────────────────
/**
 * Books an appointment: creates record, logs claim event, seeds FH diary.
 */
async function createAppointment({ claimId, providerId, appointmentType, scheduledAt, bookedByUserId }) {
  const claimService = getClaimService();

  const provider = await db.providers.findById(providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);

  const claim = await claimService.getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const appointment = await db.appointments.create({
    claim_id:         claimId,
    provider_id:      providerId,
    appointment_type: appointmentType || 'initial_eval',
    scheduled_at:     scheduledAt || new Date(Date.now() + 86400000).toISOString(),
    facility_name:    provider.name,
    facility_address: `${provider.address_line1}, ${provider.city}, ${provider.state} ${provider.zip}`,
    facility_phone:   provider.phone,
    facility_fax:     provider.fax,
    provider_email:   provider.email,
    booking_method:   'employee_self_booked',
    booked_by_user:   bookedByUserId,
    status:           'pending',
  });

  // Log claim event
  claim.events.push({
    type:      'appointment_booked',
    timestamp: new Date().toISOString(),
    data: {
      appointmentId:   appointment.id,
      providerId,
      facilityName:    provider.name,
      appointmentType: appointmentType || 'initial_eval',
    },
  });
  if (claim.intakeProgress) claim.intakeProgress.provider_selected = true;

  // Seed FileHandler diary: next appointment
  if (claim.filehandlerId) {
    try {
      const scheduledDate = (scheduledAt || appointment.scheduled_at).split('T')[0];
      await filehandler.createDiary(claim.filehandlerId, {
        type:       'NEXT_APPOINTMENT',
        dueDate:    scheduledDate,
        assignedTo: 'system@homecaretpa.com',
        priority:   'HIGH',
        notes:      `Initial eval at ${provider.name} (${provider.phone}) — Appt ID: ${appointment.id}`,
      });
      claim.events.push({
        type:      'diary_created',
        timestamp: new Date().toISOString(),
        data:      { diaryType: 'NEXT_APPOINTMENT', dueDate: scheduledDate },
      });
    } catch (err) {
      logger.error({ msg: 'appointmentService: FH diary creation failed', err: err.message });
    }
  }

  logger.info({ msg: 'appointmentService: appointment created', appointmentId: appointment.id, claimId });
  return appointment;
}

// ── confirmAppointment ────────────────────────────────────────────────────────
/**
 * Employee has entered their confirmation number from the phone call.
 * 1. Updates appointment status to 'confirmed'
 * 2. Generates + sends authorization letter to provider
 * 3. Triggers DWC-1 generation
 * 4. Advances intake progress
 */
async function confirmAppointment(appointmentId, confirmationNumber) {
  const appointment = await db.appointments.findById(appointmentId);
  if (!appointment) throw new Error(`Appointment not found: ${appointmentId}`);

  const updated = await db.appointments.update(appointmentId, {
    confirmation_number:   confirmationNumber,
    status:                'confirmed',
    authorization_sent_at: new Date().toISOString(),
  });

  const claimService = getClaimService();
  const claim = await claimService.getClaim(appointment.claim_id);

  if (claim) {
    claim.events.push({
      type:      'appointment_confirmed',
      timestamp: new Date().toISOString(),
      data:      { appointmentId, confirmationNumber, facilityName: appointment.facility_name },
    });
    if (claim.intakeProgress) claim.intakeProgress.appointment_confirmed = true;
  }

  // Async: generate auth letter + trigger DWC-1
  setImmediate(() => _postConfirmationTasks(appointment, claim).catch(err =>
    logger.error({ msg: 'appointmentService: post-confirmation tasks failed', err: err.message })
  ));

  logger.info({ msg: 'appointmentService: appointment confirmed', appointmentId, confirmationNumber });
  return updated;
}

// ── _postConfirmationTasks ────────────────────────────────────────────────────
async function _postConfirmationTasks(appointment, claim) {
  if (!claim) return;

  const employer = await db.employers.findById(claim.employerId);
  const config   = require('../config');

  // 1. Generate authorization letter PDF
  let authPdfBytes;
  try {
    authPdfBytes = await pdfService.generateAuthorizationLetter({
      claimNumber:     claim.claimNumber,
      employeeName:    `${claim.employee?.firstName} ${claim.employee?.lastName}`,
      dateOfInjury:    claim.dateOfInjury,
      bodyPart:        claim.bodyPart,
      providerName:    appointment.facility_name,
      providerAddress: appointment.facility_address,
      appointmentDate: appointment.scheduled_at,
      adjusterName:    config.adjuster?.name || 'Akash Kumar',
      adjusterPhone:   config.adjuster?.phone || process.env.ADJUSTER_PHONE,
      adjusterEmail:   config.adjuster?.email || process.env.ADJUSTER_EMAIL,
    });
  } catch (err) {
    logger.error({ msg: '_postConfirmationTasks: auth letter generation failed', err: err.message });
  }

  // 2. Push auth letter to FileHandler
  if (authPdfBytes && claim.filehandlerId) {
    try {
      await filehandler.attachDocument(
        claim.filehandlerId,
        authPdfBytes,
        'AUTHORIZATION',
        `WC Auth — ${appointment.facility_name} — ${claim.claimNumber}`
      );
    } catch (err) {
      logger.error({ msg: '_postConfirmationTasks: FH auth letter push failed', err: err.message });
    }
  }

  // 3. Generate DWC-1
  try {
    const claimService = getClaimService();
    await _generateAndStoreDWC1(claim, employer, claimService);
  } catch (err) {
    logger.error({ msg: '_postConfirmationTasks: DWC-1 generation failed', err: err.message });
  }

  // 4. Advance claim to intake_complete if all steps done
  if (claim.intakeProgress) {
    const { voice_complete, mpn_acknowledged, provider_selected, appointment_confirmed, dwc1_generated } = claim.intakeProgress;
    if (mpn_acknowledged && provider_selected && appointment_confirmed && dwc1_generated) {
      try {
        const claimService = getClaimService();
        await claimService.updateStatus(claim.id, 'intake_complete', 'system');
        logger.info({ msg: '_postConfirmationTasks: claim advanced to intake_complete', claimId: claim.id });
      } catch (err) {
        logger.error({ msg: '_postConfirmationTasks: status advance failed', err: err.message });
      }
    }
  }
}

async function _generateAndStoreDWC1(claim, employer, claimService) {
  const pdfBytes = await pdfService.generateDWC1(claim, claim.employee, employer);

  // Store as document record
  const storagePath = `claims/${claim.id}/dwc1_${Date.now()}.pdf`;
  const doc = await db.documents.create({
    claim_id:       claim.id,
    doc_type:       'dwc1',
    source:         'generated',
    storage_path:   storagePath,
    mime_type:      'application/pdf',
    size_bytes:     pdfBytes.length,
    filehandler_pushed: false,
    pdf_buffer_b64: pdfBytes.toString('base64'), // stored in-memory for M2 (M3: Supabase Storage)
  });

  // Push to FileHandler
  if (claim.filehandlerId) {
    try {
      await filehandler.attachDocument(claim.filehandlerId, pdfBytes, 'DWC1',
        `DWC-1 Claim Form — ${claim.claimNumber}`);
      await db.documents.update(doc.id, { filehandler_pushed: true });
    } catch (err) {
      logger.error({ msg: '_generateAndStoreDWC1: FH push failed', err: err.message });
    }
  }

  // Update claim
  claim.events.push({
    type:      'dwc1_generated',
    timestamp: new Date().toISOString(),
    data:      { documentId: doc.id, storagePath },
  });
  if (claim.intakeProgress) claim.intakeProgress.dwc1_generated = true;
  claim.dwc1DocumentId = doc.id;

  logger.info({ msg: '_generateAndStoreDWC1: complete', claimId: claim.id, docId: doc.id });
  return doc;
}

module.exports = {
  logMpnAcknowledgment,
  createAppointment,
  confirmAppointment,
};
