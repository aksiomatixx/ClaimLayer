'use strict';

/**
 * Per-worker setup for the real-PostgreSQL suite. Mirrors tests/setup.js,
 * but DATABASE_URL points at the fresh database globalSetup created, so the
 * unit of work runs in transactional ('pg') mode.
 */

const fs = require('fs');
const { STATE_FILE } = require('./globalSetup');

const url = process.env.CLAIMLAYER_PG_TEST_URL
  || (fs.existsSync(STATE_FILE) && JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).url);
if (!url) throw new Error('tests/pg: the test database was not created (globalSetup did not run)');

Object.assign(process.env, {
  NODE_ENV:                  'test',
  LOG_LEVEL:                 'error',
  JWT_SECRET:                'test-jwt-secret-not-for-production',
  FILEHANDLER_API_KEY:       'mock-fh-key',
  FILEHANDLER_BASE_URL:      'http://localhost:8002',
  ADP_CLIENT_ID:             'mock',
  ADP_CLIENT_SECRET:         'mock',
  SUPABASE_URL:              'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role-key',
  SUPABASE_ANON_KEY:         'mock-anon-key',
  DATABASE_URL:              url,
  // Tests drive the queue explicitly (runOnce); the kick test turns it on.
  JOBS_KICK:                 'false',
});
