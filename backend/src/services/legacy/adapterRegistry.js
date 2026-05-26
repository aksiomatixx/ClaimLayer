'use strict';

/**
 * adapterRegistry — central lookup that maps a claim's source_system string
 * to its concrete LegacyClaimsAdapter instance.
 *
 * Used by:
 *   - legacyMigrationService — to ingest from the right system
 *   - claimService write-back paths — to push updates to the right system
 *   - integrations route — to surface adapter health in the admin UI
 *
 * Adapters are instantiated once (cheap, stateless) and cached. Adding a
 * new adapter is a 3-line change: import it, add it to ADAPTERS, list it
 * in SYSTEMS for the integrations view.
 *
 * 'native' is special: claims created in ClaimLayer (not migrated from any
 * legacy system) use A1TrackerAdapter as their write-back path, because A1
 * Tracker / FileHandler is the reference write-back today. This is what
 * "system-of-engagement on top of an existing system-of-record" means
 * concretely — even a native claim has a peer record in the customer's
 * ledger.
 *
 * FUTURE WORK: real OrigamiAdapter, GuidewireAdapter, SapiensAdapter.
 */

const A1TrackerAdapter   = require('./A1TrackerAdapter');
const MockLegacyAdapter  = require('./MockLegacyAdapter');

// Lazy-instantiated singletons.
let _a1, _mock;

function _a1Adapter()   { if (!_a1)   _a1   = new A1TrackerAdapter();   return _a1;   }
function _mockAdapter() { if (!_mock) _mock = new MockLegacyAdapter();  return _mock; }

/**
 * Resolve an adapter from a source_system value.
 * Unknown values fall back to the A1 adapter, which keeps the system safe
 * by default — the worst case is a no-op write-back to filehandler.
 *
 * @param {string} sourceSystem
 * @returns {LegacyClaimsAdapter}
 */
function getAdapter(sourceSystem) {
  switch (sourceSystem) {
    case 'native':
    case 'a1_tracker':
    case undefined:
    case null:
      return _a1Adapter();
    case 'mock_legacy':
      return _mockAdapter();
    default:
      // Unknown system — still return A1 so write-back failures surface
      // as filehandler errors rather than as TypeErrors on undefined.
      return _a1Adapter();
  }
}

/**
 * Connected systems summary for the Integrations admin view. The route
 * layer enriches each entry with healthCheck output + claim_count.
 */
const SYSTEMS = [
  {
    system:      'a1_tracker',
    label:       'A1 Tracker / FileHandler',
    role:        'Reference write-back implementation',
    direction:   'write-back',
    description: 'Wraps the existing FileHandler client. Production write-back path for native and a1_tracker claims.',
  },
  {
    system:      'mock_legacy',
    label:       'Mock Legacy System',
    role:        'Demo round trip',
    direction:   'bidirectional',
    description: 'Backed by legacy_* tables. Demonstrates ingest + write-back without any external dependency.',
  },
];

module.exports = { getAdapter, SYSTEMS };
