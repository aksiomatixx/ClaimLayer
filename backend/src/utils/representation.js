'use strict';

/**
 * Shared attorney-representation check (M17B consolidation).
 *
 * claims.attorney_represented is the authoritative column (M17B,
 * written by claimService.setAttorneyRepresentation). The legacy ad-hoc
 * fields (attorneyName / attorney_name / representedBy) remain readable
 * as fallback until historical rows are migrated; any of them set means
 * represented.
 *
 * Single source of truth for pdService, cnrService, and
 * disbursementService — do not re-inline this OR-chain.
 */
function isRepresented(claim) {
  if (!claim) return false;
  return !!(
    claim.attorney_represented ||
    claim.attorneyName ||
    claim.attorney_name ||
    claim.representedBy
  );
}

module.exports = { isRepresented };
