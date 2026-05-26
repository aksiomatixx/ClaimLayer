'use strict';

/**
 * A1TrackerAdapter — adapter for A1 Tracker / FileHandler Enterprise (JW
 * Software). Wraps the existing filehandler client; this is the reference
 * write-back implementation that the LegacyClaimsAdapter interface is
 * modelled on.
 *
 * Design:
 *   - DELEGATES to filehandler.js for every push* method. The existing
 *     filehandler module already handles retries, auth, and audit logging;
 *     replicating that here would only create drift.
 *   - Does NOT modify filehandler.js. Tests that jest.mock the filehandler
 *     module continue to intercept these calls transparently because we
 *     require() it inside this adapter.
 *   - ingestClaims returns [] for now. Pulling claims out of A1 Tracker is
 *     listed as future work — A1 / FileHandler is the customer's primary
 *     system-of-record for the existing platform, so claims in that system
 *     already flow into ClaimLayer through the normal FROI path, not via
 *     a bulk pull.
 *
 * For native ClaimLayer claims (source_system='native'), the adapter
 * registry returns A1TrackerAdapter so the legacy adapter pattern is the
 * single code path for write-back regardless of origin. This keeps the
 * interface contract clean — every claim has an adapter, even if the
 * adapter delegates to the same underlying ledger as before.
 */

const { LegacyClaimsAdapter } = require('./LegacyClaimsAdapter');
const filehandler = require('../filehandler');
const logger      = require('../../logger');

class A1TrackerAdapter extends LegacyClaimsAdapter {
  constructor() {
    super('a1_tracker');
  }

  async healthCheck() {
    // FileHandler exposes no dedicated health endpoint in the mock; assume
    // healthy and report the configured base URL for the Integrations view.
    const baseUrl = require('../../config').filehandler?.baseUrl || '(unset)';
    return {
      ok:     true,
      system: this.system,
      detail: `Delegating to filehandler at ${baseUrl}`,
    };
  }

  // FUTURE WORK: bulk pull from A1 / FileHandler. Today, claims enter
  // ClaimLayer via the FROI flow (claimService.createClaim) which already
  // writes to filehandler on create. A reverse-direction ingest is only
  // needed when ClaimLayer is layered onto an A1 deployment with pre-existing
  // claims — outside this milestone.
  async ingestClaims(/* filter */) {
    return [];
  }

  async pushClaimUpdate(externalClaimId, { field, oldValue, newValue }) {
    // FileHandler doesn't expose a generic field-update endpoint in the
    // mock; the closest semantic is a status event in the ledger. Log it
    // and return — sufficient for the reference impl + demo.
    logger.info({
      msg: 'A1TrackerAdapter.pushClaimUpdate (no-op)', externalClaimId, field, oldValue, newValue,
    });
    return { ok: true, system: this.system, field };
  }

  async pushDiary(externalClaimId, diary) {
    return filehandler.createDiary(externalClaimId, {
      type:       diary.type,
      dueDate:    diary.dueDate,
      assignedTo: diary.assignedTo,
      priority:   diary.priority,
      notes:      diary.notes,
    });
  }

  async pushDocument(externalClaimId, document) {
    if (!document.fileBuffer) {
      // FileHandler's attachDocument requires a buffer. For metadata-only
      // pushes (e.g. summary of a generated artifact), return a stub.
      return { ok: true, system: this.system, docType: document.docType, metadataOnly: true };
    }
    return filehandler.attachDocument(
      externalClaimId,
      document.fileBuffer,
      document.docType,
      document.title || document.summary || document.docType,
      document.receivedDate,
    );
  }

  async pushNotice(externalClaimId, notice) {
    // Notices are pushed to filehandler as documents — same endpoint, same
    // shape. The notice type lives in docType so the legacy system can
    // distinguish them in its document index.
    return this.pushDocument(externalClaimId, {
      docType:  notice.noticeType || 'NOTICE',
      title:    notice.title,
      summary:  notice.summary,
      fileBuffer: notice.fileBuffer,
    });
  }
}

module.exports = A1TrackerAdapter;
