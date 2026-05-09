#!/usr/bin/env node
'use strict';

/**
 * db-reset.js — wipe all demo-flagged claim data.
 *
 * Used by `npm run dev:demo` to start from a known clean slate
 * before seeding. Only touches rows with metadata.demo === true,
 * so it is safe to run against a Supabase instance that also has
 * real (non-demo) claims.
 *
 * Hard-blocked when NODE_ENV === 'production'.
 */

if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.error('✗ db-reset is blocked when NODE_ENV=production');
  process.exit(1);
}

const path = require('path');
process.chdir(path.join(__dirname, '..', 'backend'));
require('dotenv').config();

const { wipeDemo } = require('../backend/src/scripts/seedDemo');

wipeDemo()
  .then((n) => {
    // eslint-disable-next-line no-console
    console.log(`✓ db:reset — wiped ${n} demo claim slots`);
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('✗ db:reset failed:', err.message);
    process.exit(1);
  });
