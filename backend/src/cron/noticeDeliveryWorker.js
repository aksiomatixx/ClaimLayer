'use strict';

/**
 * noticeDeliveryWorker.js — the explicit worker that drives
 * noticeDeliveryService.deliverPending().
 *
 * House cron convention (see wcisDeadlineMonitor): a module exporting
 * run(), invoked by the scheduler in production and by the
 * authenticated internal endpoint POST /api/v1/admin/workers/
 * notice-delivery/run on demand.
 *
 * Recommended schedule: every 15 minutes.
 *
 * Safe to run concurrently: every notice is claimed with a conditional
 * status update (locked_by/locked_at) inside deliverPending, so two
 * overlapping workers cannot deliver the same notice. Stale locks from
 * a crashed worker are reclaimed after LOCK_TTL_MS.
 */

const crypto = require('crypto');
const noticeDelivery = require('../services/noticeDeliveryService');
const logger = require('../logger');

async function run(workerId) {
  const owner = workerId || `notice-worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const outcomes = await noticeDelivery.deliverPending(owner);
  const summary = outcomes.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});
  logger.info({ msg: 'noticeDeliveryWorker: complete', worker: owner, processed: outcomes.length, ...summary });
  return { worker: owner, processed: outcomes.length, outcomes };
}

module.exports = { run };
