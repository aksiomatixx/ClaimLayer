'use strict';

/**
 * supervisorAlertWorker.js — the daily business-morning job that
 * generates the supervisor digest (CL-SUP1).
 *
 * House cron convention (see wcisDeadlineMonitor): a module exporting
 * run(), invoked by the scheduler in production and by the
 * authenticated internal endpoint POST /api/v1/admin/workers/
 * supervisor-alerts/run on demand.
 *
 * Recommended schedule: 06:30 America/Los_Angeles, Monday–Friday.
 * The date is computed in America/Los_Angeles inside the service, and
 * non-business days (weekends + California state holidays) are skipped
 * here, so an over-eager scheduler cannot produce weekend digests.
 * Generation is idempotent per (date, supervisor) — a re-run updates.
 */

const alerts = require('../services/supervisorAlertService');
const { isBusinessDay } = require('../utils/businessDays');
const logger = require('../logger');

async function run(dateOverride) {
  const date = dateOverride || alerts.todayLA();
  if (!isBusinessDay(date)) {
    logger.info({ msg: 'supervisorAlertWorker: not a business day — skipped', date });
    return { date, skipped: 'not_a_business_day' };
  }
  const result = await alerts.generate(date);
  logger.info({
    msg: 'supervisorAlertWorker: complete', date,
    recipients: result.recipients, alerts: result.alerts.length,
  });
  return result;
}

module.exports = { run };
