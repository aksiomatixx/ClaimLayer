#!/usr/bin/env node
'use strict';

/**
 * dev.js — spawn backend (port 3001) and frontend (port 5173) in
 * parallel. No external `concurrently` dependency — keeps the
 * monorepo install footprint at zero packages.
 *
 * Both child processes share stdout/stderr so the reviewer sees a
 * single stream. Ctrl-C in the parent terminates both.
 */

const { spawn } = require('child_process');
const path      = require('path');

const REPO = path.join(__dirname, '..');

const procs = [
  spawn('npm', ['run', 'dev'], {
    cwd:   path.join(REPO, 'backend'),
    stdio: 'inherit',
    env:   { ...process.env, FORCE_COLOR: '1' },
  }),
  spawn('npm', ['run', 'dev'], {
    cwd:   path.join(REPO, 'frontend'),
    stdio: 'inherit',
    env:   { ...process.env, FORCE_COLOR: '1' },
  }),
];

const cleanup = (signal) => {
  for (const p of procs) { try { p.kill(signal || 'SIGTERM'); } catch { /* */ } }
};

process.on('SIGINT',  () => { cleanup('SIGINT');  process.exit(0); });
process.on('SIGTERM', () => { cleanup('SIGTERM'); process.exit(0); });

procs.forEach((p, i) => {
  p.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.error(`[dev.js] child ${i === 0 ? 'backend' : 'frontend'} exited (${code}) — shutting down`);
    cleanup('SIGTERM');
    process.exit(code || 0);
  });
});
