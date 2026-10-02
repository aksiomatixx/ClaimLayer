'use strict';

const fs = require('fs');
const { Client } = require('pg');
const { STATE_FILE } = require('./globalSetup');

module.exports = async function globalTeardown() {
  if (process.env.PG_TEST_KEEP_DB === 'true' || !fs.existsSync(STATE_FILE)) return;
  const { adminUrl, name } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
    fs.unlinkSync(STATE_FILE);
  }
};
