'use strict';

/**
 * Real-PostgreSQL test suite (ADR-0006): npm run test:pg
 *
 * Proves what the in-memory suite cannot — transactions, rollbacks, row
 * locks, SKIP LOCKED claims, deadlock retries, ledger atomicity. Needs a
 * PostgreSQL server; PG_TEST_ADMIN_URL (or DATABASE_URL) must point at a
 * database the user can CREATE DATABASE from. A fresh, uniquely named
 * database gets every migration and is dropped afterwards.
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/tests/pg/**/*.pg.test.js'],
  globalSetup: '<rootDir>/tests/pg/globalSetup.js',
  globalTeardown: '<rootDir>/tests/pg/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/pg/setup.js'],
  testTimeout: 30000,
  verbose: true,
};
