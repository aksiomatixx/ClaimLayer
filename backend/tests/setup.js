'use strict';

/**
 * Jest global setup — loads .env.test if present, otherwise falls back to
 * environment variables already set (e.g. injected by GitHub Actions).
 *
 * Provides safe defaults so tests can run without a .env file in CI
 * as long as the required secrets are injected via the workflow env block.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: false });

// Safe defaults for anything not already set
const defaults = {
  NODE_ENV:                    'test',
  PORT:                        '3001',
  LOG_LEVEL:                   'warn',    // keep test output clean
  JWT_SECRET:                  'test-jwt-secret-not-for-production',
  FILEHANDLER_API_KEY:         'mock-fh-key',
  FILEHANDLER_BASE_URL:        'http://localhost:8002',
  ADP_CLIENT_ID:               'mock',
  ADP_CLIENT_SECRET:           'mock',
  ADP_AUTH_URL:                'http://localhost:8001/auth/oauth/v2/token',
  ADP_BASE_URL:                'http://localhost:8001',
  // Supabase — mock values used when the real DB is not available
  SUPABASE_URL:                'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY:   'mock-service-role-key',
  SUPABASE_ANON_KEY:           'mock-anon-key',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}

// Warn if Anthropic key is missing — AI tests will be skipped, not failed
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('\n⚠  ANTHROPIC_API_KEY not set — AI analysis tests will be skipped\n');
}
