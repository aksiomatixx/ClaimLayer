'use strict';

/**
 * Postgres connection pool for transactional writes (ADR-0006).
 *
 * Type normalization: the rest of the codebase (and the in-memory test
 * double) was written against PostgREST's JSON shapes — timestamps as ISO
 * strings, dates as 'YYYY-MM-DD', numerics and bigints as numbers. Raw
 * node-postgres returns Date objects and numeric strings instead, which
 * would silently break string comparisons and arithmetic. The pool's
 * parsers return the PostgREST shapes so both access paths agree.
 */

const pg     = require('pg');
const config = require('../config');
const logger = require('../logger');

const OID = Object.freeze({
  INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184,
});

const _defaultTimestamptz = pg.types.getTypeParser(OID.TIMESTAMPTZ);

function _toIso(raw) {
  const d = _defaultTimestamptz(raw);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : raw;
}

const PARSERS = {
  [OID.TIMESTAMPTZ]: _toIso,
  // timestamp without time zone is stored as UTC by convention.
  [OID.TIMESTAMP]:   (raw) => _toIso(`${raw}+00`),
  [OID.DATE]:        (raw) => raw,
  [OID.NUMERIC]:     (raw) => parseFloat(raw),
  [OID.INT8]:        (raw) => {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : raw;
  },
};

const types = {
  getTypeParser(oid, format) {
    if (format !== 'binary' && PARSERS[oid]) return PARSERS[oid];
    return pg.types.getTypeParser(oid, format);
  },
};

function _sslOption(url, mode, ca) {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url) || /host=\/|%2F/.test(url);
  const effective = mode || (isLocal ? 'disable' : 'require');
  if (effective === 'disable') return false;
  if (effective === 'require') return { rejectUnauthorized: false };
  if (effective === 'verify') {
    return ca ? { rejectUnauthorized: true, ca: ca.replace(/\\n/g, '\n') } : { rejectUnauthorized: true };
  }
  throw new Error(`DATABASE_SSL must be disable | require | verify (got '${effective}')`);
}

let _pool = null;

/** The shared pool, or null when DATABASE_URL is not configured. */
function getPool() {
  if (!config.database.url) return null;
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString:  config.database.url,
      ssl:               _sslOption(config.database.url, config.database.ssl, config.database.sslCa),
      max:               config.database.poolMax,
      statement_timeout: config.database.statementTimeoutMs,
      application_name:  'claimlayer-api',
      types,
    });
    _pool.on('error', (err) => logger.error({ msg: 'db pool: idle client error', err: err.message }));
  }
  return _pool;
}

async function closePool() {
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

module.exports = { getPool, closePool, types, _sslOption };
