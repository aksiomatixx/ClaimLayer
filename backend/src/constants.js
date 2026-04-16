'use strict';

/**
 * Shared application constants.
 *
 * Used by route validators, claimService, and tests.
 * Single source of truth for all controlled-vocabulary fields.
 */

// ── Claim status ──────────────────────────────────────────────────────────────
// All valid values for claims.status (mirrors DB CHECK constraint).
const CLAIM_STATUSES = [
  'new_claim',
  'intake_complete',
  'under_investigation',
  'accepted',
  'active_medical',
  'future_medical_only',   // RTW; medical treatment ongoing, no indemnity
  'p_and_s',
  'pd_evaluation',
  'settlement_discussions',
  'litigated',
  'denied',
  'closed',
];

// Statuses that can be set via PATCH /api/v1/claims/:id/status.
// 'new_claim' is excluded — set only on creation.
const SETTABLE_CLAIM_STATUSES = CLAIM_STATUSES.filter(s => s !== 'new_claim');

// ── Subrogation status ────────────────────────────────────────────────────────
// Must match the CHECK constraint in migration 20260101000005_m6_retrofit.sql
const SUBROGATION_STATUSES = [
  'not_applicable',    // Default — no subrogation potential identified
  'under_evaluation',  // Set automatically when injuryType === 'Motor Vehicle'
  'waived',            // TPA decided not to pursue
  'referred',          // Referred to subrogation unit / outside counsel
  'recovered',         // Recovery completed
];

// ── Document category ─────────────────────────────────────────────────────────
// High-level grouping for document classification / UI filtering.
const DOCUMENT_CATEGORIES = [
  'medical',
  'bill',
  'legal',
  'qme',
  'state_form',
  'rfa',
  'pharmacy',
  'correspondence',
  'surveillance',
  'wage',
  'other',
];

module.exports = {
  CLAIM_STATUSES,
  SETTABLE_CLAIM_STATUSES,
  SUBROGATION_STATUSES,
  DOCUMENT_CATEGORIES,
};
