'use strict';

/**
 * LegacyClaimsAdapter — base class / interface for legacy claims-system
 * integration.
 *
 * ClaimLayer is designed to deploy on top of a customer's existing claims
 * system-of-record (Origami Risk, Guidewire ClaimCenter, Sapiens, A1 Tracker,
 * FileHandler / JW Software, etc.) rather than replace it. Adapter
 * implementations:
 *
 *   - INGEST canonical claim records from the legacy system into this
 *     platform so AI-assisted workflows can run on them, AND
 *   - PUSH BACK status changes, diaries, documents, and notices to the
 *     legacy system so its system-of-record remains authoritative.
 *
 * Every method throws NotImplemented in the base class. Concrete adapters
 * (A1TrackerAdapter, MockLegacyAdapter, future Origami / Guidewire /
 * Sapiens adapters) override the methods they support.
 *
 * Ingest contract — ingestClaims must return drafts shaped like ClaimLayer's
 * canonical claim payload so claimService can persist them without further
 * translation:
 *
 *   {
 *     external_claim_id: 'LEG-001',          // adapter's stable PK
 *     source_system:     'mock_legacy',      // matches adapter.system
 *     employer_name:     'BrightCare ...',
 *     date_of_injury:    '2026-04-12',       // ISO YYYY-MM-DD
 *     body_part:         'Lumbar Spine / Lower Back',
 *     injury_type:       'Lifting Injury',
 *     status:            'intake_complete',  // canonical native status
 *     employee: {
 *       firstName, lastName, dob, phone, address: { line1, state, zip },
 *       jobTitle,
 *     },
 *     aww:               750.75,
 *     td_rate:           500.50,
 *     raw:               { ... }             // entire legacy record for audit
 *   }
 *
 * The migration service (legacyMigrationService) maps these drafts to
 * claims-table rows with source_system + external_claim_id set, and is
 * responsible for de-duplication on re-run.
 *
 * Write-back contract — push* methods are best-effort. They MUST NOT throw
 * into the caller's main operation. The caller (claimService) wraps each
 * call, logs a claim_event on failure, and toggles sync_status.
 */

class NotImplementedError extends Error {
  constructor(method, adapter) {
    super(`${adapter}: ${method}() not implemented`);
    this.name = 'NotImplementedError';
  }
}

class LegacyClaimsAdapter {
  /**
   * @param {string} system  — short identifier matching claims.source_system
   *                           (e.g. 'native', 'a1_tracker', 'mock_legacy')
   */
  constructor(system) {
    this.system = system;
  }

  /**
   * Confirm the adapter can reach its backing system.
   * @returns {Promise<{ ok: boolean, system: string, detail?: string,
   *                     claim_count?: number }>}
   */
  async healthCheck() {
    throw new NotImplementedError('healthCheck', this.constructor.name);
  }

  /**
   * Pull claims from the legacy system and normalize them into canonical
   * claim drafts. Adapters MAY accept an opaque filter argument (date range,
   * employer scope, claim-status whitelist). The migration service does
   * NOT inspect the filter — it forwards as-is.
   *
   * @param {object} [filter]
   * @returns {Promise<Array>} canonical claim drafts (see file-level docs)
   */
  // eslint-disable-next-line no-unused-vars
  async ingestClaims(filter) {
    throw new NotImplementedError('ingestClaims', this.constructor.name);
  }

  /**
   * Push a field-level claim update back to the legacy system.
   * @param {string} externalClaimId
   * @param {{ field: string, oldValue: any, newValue: any }} change
   */
  // eslint-disable-next-line no-unused-vars
  async pushClaimUpdate(externalClaimId, change) {
    throw new NotImplementedError('pushClaimUpdate', this.constructor.name);
  }

  /**
   * Push a diary entry to the legacy system.
   * @param {string} externalClaimId
   * @param {{ type: string, dueDate: string, notes?: string,
   *           priority?: string, assignedTo?: string }} diary
   */
  // eslint-disable-next-line no-unused-vars
  async pushDiary(externalClaimId, diary) {
    throw new NotImplementedError('pushDiary', this.constructor.name);
  }

  /**
   * Push a document reference (or payload) to the legacy system.
   * @param {string} externalClaimId
   * @param {{ docType: string, title: string, summary?: string,
   *           fileBuffer?: Buffer }} document
   */
  // eslint-disable-next-line no-unused-vars
  async pushDocument(externalClaimId, document) {
    throw new NotImplementedError('pushDocument', this.constructor.name);
  }

  /**
   * Push a generated regulatory notice to the legacy system.
   * @param {string} externalClaimId
   * @param {{ noticeType: string, title: string, summary?: string,
   *           fileBuffer?: Buffer }} notice
   */
  // eslint-disable-next-line no-unused-vars
  async pushNotice(externalClaimId, notice) {
    throw new NotImplementedError('pushNotice', this.constructor.name);
  }
}

module.exports = { LegacyClaimsAdapter, NotImplementedError };
