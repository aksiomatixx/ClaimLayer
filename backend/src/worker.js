'use strict';

/**
 * worker.js — long-running background worker (ADR-0006).
 *
 *   npm run worker
 *
 * Polls the durable job queue (retries, expired leases, scheduled jobs) and,
 * on each idle poll, the integration outbox (FileHandler write-backs). Run
 * one or more of these beside the API in production; several workers are
 * safe (SKIP LOCKED / conditional claims). Requires DATABASE_URL.
 *
 * SIGTERM / SIGINT: stop claiming, finish the in-flight batch, close the
 * pool, exit. A job interrupted by a hard kill is reclaimed when its lease
 * expires.
 */

const config   = require('./config');
const logger   = require('./logger');
const { getPool, closePool } = require('./db/pool');
const jobQueue = require('./services/jobQueue');

const OUTBOX_EVERY_MS = 60 * 1000;

function main() {
  if (!getPool()) {
    logger.error({ msg: 'worker: DATABASE_URL is required' });
    process.exit(1);
  }

  let lastOutbox = 0;
  const onIdle = async () => {
    if (Date.now() - lastOutbox < OUTBOX_EVERY_MS) return;
    lastOutbox = Date.now();
    try {
      await require('./cron/outboxWorker').run();
    } catch (err) {
      logger.error({ msg: 'worker: outbox dispatch failed', err: err.message });
    }
  };

  const poller = jobQueue.startPoller({ intervalMs: config.jobs.pollIntervalMs, onIdle });
  logger.info({ msg: 'worker: started', workerId: poller.workerId, pollIntervalMs: config.jobs.pollIntervalMs });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ msg: 'worker: stopping', signal });
    try {
      await poller.stop();
      await closePool();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { main };
