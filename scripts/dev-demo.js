#!/usr/bin/env node
'use strict';

/**
 * dev-demo.js — orchestrator for `npm run dev:demo`.
 *
 * Sequence:
 *   1. db:reset    — wipe any existing demo-flagged claims
 *   2. seedDemo    — recreate the 8-claim demo dataset
 *   3. dev         — spawn backend + frontend
 *
 * Steps 1 and 2 are sequential and exit on failure. Step 3 takes
 * over the foreground.
 */

if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.error('✗ dev:demo is blocked when NODE_ENV=production');
  process.exit(1);
}

const { spawnSync, spawn } = require('child_process');
const path                 = require('path');
const REPO = path.join(__dirname, '..');

function step(name, cmd, args, cwd) {
  // eslint-disable-next-line no-console
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' } });
  if (r.status !== 0) {
    // eslint-disable-next-line no-console
    console.error(`✗ ${name} failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

step('db:reset',  'node', [path.join(__dirname, 'db-reset.js')], REPO);
step('seed:demo', 'node', [path.join(REPO, 'backend', 'src', 'scripts', 'seedDemo.js')], path.join(REPO, 'backend'));

// eslint-disable-next-line no-console
console.log('\n▶ dev (backend on :3001 + frontend on :5173)');
const dev = spawn('node', [path.join(__dirname, 'dev.js')], {
  cwd: REPO, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '1' },
});
process.on('SIGINT',  () => { try { dev.kill('SIGINT'); } catch { /* */ } process.exit(0); });
process.on('SIGTERM', () => { try { dev.kill('SIGTERM'); } catch { /* */ } process.exit(0); });
dev.on('exit', (code) => process.exit(code || 0));
