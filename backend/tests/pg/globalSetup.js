'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { applySchema } = require('../../scripts/lib/testDatabase');

const STATE_FILE = path.join(os.tmpdir(), 'claimlayer-pg-test.json');

function _withDatabase(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

module.exports = async function globalSetup() {
  const adminUrl = process.env.PG_TEST_ADMIN_URL || process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error('test:pg needs PG_TEST_ADMIN_URL (or DATABASE_URL) pointing at a PostgreSQL server');
  }
  const name = `claimlayer_pgtest_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = _withDatabase(adminUrl, name);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applySchema(client);
  } finally {
    await client.end();
  }

  process.env.CLAIMLAYER_PG_TEST_URL = url; // inherited by test workers
  fs.writeFileSync(STATE_FILE, JSON.stringify({ adminUrl, name, url }));
};

module.exports.STATE_FILE = STATE_FILE;
