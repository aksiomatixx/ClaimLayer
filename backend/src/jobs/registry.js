'use strict';

/**
 * Job registry (ADR-0006) — every queue the durable job queue accepts, with
 * its handler and retry budget. Enqueueing an unregistered queue throws, so
 * a typo fails at the call site instead of dead-lettering later.
 *
 * Handler contract:
 *   * payload is plain JSON (it round-trips through the jobs table); carry
 *     ids and immutable event facts, and reload mutable records by id.
 *   * A handler may run more than once (retry after a failure, or a second
 *     worker reclaiming an expired lease), so it must be idempotent or rely
 *     on an idempotent downstream (wcisTriggerService dedupes its triggers;
 *     the FileHandler push checks filehandler_pushed first).
 *   * Throw to fail the attempt: the queue retries with backoff and
 *     dead-letters after maxAttempts (ledger entry + claim diary).
 *   * Handlers call services through their module exports (lazy require),
 *     so the module graph stays acyclic and test doubles still apply.
 *
 * maxAttempts is 1 where a repeat is not safe or not useful.
 */

const svc = (name) => require(`../services/${name}`);

const QUEUES = {
  // claimService.createClaim
  'claim.analysis': {
    maxAttempts: 3,
    run: (p) => svc('claimService')._runAnalysis(p.claimId),
  },
  'notice.dwc7': {
    maxAttempts: 5,
    run: (p) => svc('noticeService').generateDwc7(p.claimId),
  },
  // claimService.createClaim / updateStatus; cnr, disbursement and PD hooks.
  // wcisTriggerService gates (wcis_enabled, DOI cutoff) and dedupes.
  'wcis.trigger': {
    maxAttempts: 8,
    run: (p) => svc('wcisTriggerService').enqueueIfReportable(p.trigger),
  },
  'wcis.cnr_paid': {
    maxAttempts: 8,
    run: (p) => svc('cnrService')._wcisOnPayment(p),
  },
  'wcis.disbursement_paid': {
    maxAttempts: 8,
    run: (p) => svc('disbursementService')._wcisOnPayment(p),
  },
  'wcis.pd_advances_initiated': {
    maxAttempts: 8,
    run: (p) => svc('pdService')._wcisOnAdvancesInitiated(p),
  },
  'wcis.pd_advance_paid': {
    maxAttempts: 8,
    run: (p) => svc('pdService')._wcisOnAdvancePayment(p),
  },
  // claimService.updateStatus — the adapter records its own failures as
  // claim events and never throws, so a retry would only repeat the push.
  'claim.legacy_writeback': {
    maxAttempts: 1,
    run: (p) => svc('claimService')._legacyWriteBackUpdate(p.claimId, p.change),
  },
  // appointmentService.confirmAppointment — generates documents; each step
  // logs its own failure, a blind repeat would duplicate the DWC-1.
  'appointment.post_confirmation': {
    maxAttempts: 1,
    run: (p) => svc('appointmentService')._runPostConfirmation(p.appointmentId),
  },
  // qmeService.recordReportReceived
  'qme.supplemental_evaluation': {
    maxAttempts: 3,
    run: (p) => svc('supplementalRequestService').evaluateQmeReport(p.panelId),
  },
  // rfaService.createRFA / RFA approval
  'rfa.evaluate': {
    maxAttempts: 3,
    run: (p) => svc('rfaService').evaluateRFA(p.rfaId),
  },
  'notice.rfa_letter': {
    maxAttempts: 5,
    run: (p) => svc('noticeService').generateRfaLetter(p.rfaId),
  },
  // routes/documents.js confirm-upload
  'documents.filehandler_push': {
    maxAttempts: 5,
    run: (p) => svc('documentPushService').pushToFileHandler(p.documentId),
  },
};

function get(queue) {
  return Object.prototype.hasOwnProperty.call(QUEUES, queue) ? QUEUES[queue] : null;
}

function names() {
  return Object.keys(QUEUES);
}

module.exports = { get, names, QUEUES };
