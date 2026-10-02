'use strict';

/**
 * Shared helpers for tests that run against a REAL PostgreSQL database:
 * the migration contract test (scripts/migration-contract-test.js) and the
 * transactional test suite (npm run test:pg, tests/pg/).
 */

const fs   = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');

// Vanilla Postgres lacks the Supabase runtime objects some migrations
// reference (RLS policies use the authenticated role and auth.uid()).
const SUPABASE_SHIMS = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN;
    END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
`;

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

/** Apply the shims and every migration, in filename order, on `client`. */
async function applySchema(client, { onApplied = () => {} } = {}) {
  await client.query(SUPABASE_SHIMS);
  for (const f of migrationFiles()) {
    await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    onApplied(f);
  }
}

module.exports = { MIGRATIONS_DIR, SUPABASE_SHIMS, migrationFiles, applySchema };
