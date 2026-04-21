'use strict';

/**
 * vendorAdapter.js — M22A.2 SCAFFOLD.
 *
 * Third-party EDI vendor integration (e.g., HealtheSystems,
 * Mitchell, etc.). Gated on vendor contract + API credentials.
 * Shell only; every method throws AdapterNotImplemented.
 */

const { AdapterNotImplemented } = require('./wcisAdapterInterface');

const NAME = 'vendor';
const MILESTONE = 'M22A.2';

async function transmit(_batch) {
  throw new AdapterNotImplemented('vendorAdapter', MILESTONE);
}

async function pollAcks(_environment) {
  throw new AdapterNotImplemented('vendorAdapter', MILESTONE);
}

async function healthCheck() {
  throw new AdapterNotImplemented('vendorAdapter', MILESTONE);
}

module.exports = {
  name: NAME,
  transmit,
  pollAcks,
  healthCheck,
};
