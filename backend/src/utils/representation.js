'use strict';

/**
 * Shared attorney-representation check (M17B consolidation).
 *
 * Historically claims have recorded representation in four places —
 * attorney_represented (the formal column), attorneyName / attorney_name
 * (camel/snake variants), and representedBy. Until the data is migrated
 * onto attorney_represented alone, "represented" means any of them is set.
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
