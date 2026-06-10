'use strict';

/**
 * outboxWorker.js — drives outboxService.dispatchPending(): retries
 * every due integration_outbox row (FileHandler write-backs that failed
 * their opportunistic dispatch).
 *
 * House cron convention (see wcisDeadlineMonitor): a module exporting
 * run(), invoked by the scheduler in production and by the
 * authenticated internal endpoint POST /api/v1/admin/workers/outbox/run
 * on demand. Recommended schedule: every 5 minutes.
 *
 * Concurrency-safe: rows are claimed with conditional updates.
 */

const crypto = require('crypto');
const outbox = require('../services/outboxService');
const logger = require('../logger');

async function run(workerId) {
  const owner = workerId || `outbox-worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const outcomes = await outbox.dispatchPending(owner);
  const summary = outcomes.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});
  logger.info({ msg: 'outboxWorker: complete', worker: owner, processed: outcomes.length, ...summary });
  return { worker: owner, processed: outcomes.length, outcomes };
}

module.exports = { run };
