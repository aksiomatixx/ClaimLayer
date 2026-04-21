'use strict';

/**
 * sftpAdapter.js — M22A.1 SCAFFOLD.
 *
 * Real SFTP implementation against the DWC-hosted WCIS server.
 * Gated on DWC trading-partner credentials. Shell only; every
 * method throws AdapterNotImplemented.
 */

const { AdapterNotImplemented } = require('./wcisAdapterInterface');

const NAME = 'sftp';
const MILESTONE = 'M22A.1';

async function transmit(_batch) {
  throw new AdapterNotImplemented('sftpAdapter', MILESTONE);
}

async function pollAcks(_environment) {
  throw new AdapterNotImplemented('sftpAdapter', MILESTONE);
}

async function healthCheck() {
  throw new AdapterNotImplemented('sftpAdapter', MILESTONE);
}

module.exports = {
  name: NAME,
  transmit,
  pollAcks,
  healthCheck,
};
