'use strict';

/**
 * jobWorker.js — drains due jobs from the durable job queue (ADR-0006).
 *
 * House cron convention (see outboxWorker): run() is invoked by a scheduler
 * or by the authenticated endpoint POST /api/v1/admin/workers/jobs/run.
 * The long-running alternative is src/worker.js (npm run worker), which
 * polls continuously. All of them are concurrency-safe: jobs are claimed
 * with FOR UPDATE SKIP LOCKED under a lease.
 */

const jobQueue = require('../services/jobQueue');
const logger   = require('../logger');

const MAX_BATCHES = 20;

async function run({ limit = 10, maxBatches = MAX_BATCHES } = {}) {
  const total = { batches: 0, claimed: 0, succeeded: 0, retried: 0, dead: 0 };
  for (let i = 0; i < maxBatches; i++) {
    const s = await jobQueue.runOnce({ limit });
    total.batches += 1;
    for (const k of ['claimed', 'succeeded', 'retried', 'dead']) total[k] += s[k];
    if (s.claimed < limit) break;
  }
  logger.info({ msg: 'jobWorker: complete', ...total });
  return total;
}

module.exports = { run };
