'use strict';

/**
 * ADP Workforce Now client.
 *
 * Override both URLs to hit a local mock server during development:
 *
 *   ADP_AUTH_URL=http://localhost:4002/auth/oauth/v2/token
 *   ADP_BASE_URL=http://localhost:4002
 *   ADP_CLIENT_ID=mock-id
 *   ADP_CLIENT_SECRET=mock-secret
 *
 * Token is cached in memory and refreshed 60 s before it expires
 * (per integrations.md spec).
 */

const axios  = require('axios');
const qs     = require('qs');
const config = require('../config');
const logger = require('../logger');

// ── Token cache ───────────────────────────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  logger.info({ msg: 'ADP: fetching new access token', authUrl: config.adp.authUrl });

  const res = await axios.post(
    config.adp.authUrl,
    qs.stringify({
      grant_type:    'client_credentials',
      client_id:     config.adp.clientId,
      client_secret: config.adp.clientSecret,
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    }
  );

  const { access_token, expires_in } = res.data;

  // Expire 60 s early so we never send a stale token
  _tokenCache = {
    token:     access_token,
    expiresAt: now + (expires_in - 60) * 1_000,
  };

  logger.info({ msg: 'ADP: token acquired', expiresIn: expires_in });
  return access_token;
}

// Exposed for tests only — lets tests reset the cache between cases
function _resetTokenCache() {
  _tokenCache = { token: null, expiresAt: 0 };
}

// ── Axios instance (built fresh each call so it always has current token) ────
async function adpClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL:  config.adp.baseUrl,
    timeout:  15_000,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ── Employee demographics ─────────────────────────────────────────────────────

/**
 * Look up a worker by the internal employee ID stored in ADP custom fields.
 * Returns a normalised employee object.
 */
async function getEmployee(adpEmployeeId) {
  const client = await adpClient();
  const res = await client.get('/hr/v2/workers', {
    params: {
      $filter: `workers/customFieldGroup/stringFields/stringValue eq '${adpEmployeeId}'`,
    },
  });

  const workers = res.data?.workers;
  if (!workers || workers.length === 0) {
    throw new Error(`ADP: no worker found for employee id "${adpEmployeeId}"`);
  }

  return normaliseWorker(workers[0]);
}

function normaliseWorker(w) {
  const person = w.person        || {};
  const name   = person.legalName || {};
  const addr   = person.homeAddress || {};
  const comms  = w.businessCommunication || {};

  return {
    associateOID: w.associateOID,
    firstName:    name.givenName,
    lastName:     name.familyName,
    dob:          person.birthDate,
    address: {
      line1:  addr.lineOne,
      city:   addr.cityName,
      state:  addr.countrySubdivisionLevel1?.codeValue,
      zip:    addr.postalCode,
    },
    phone:     comms.landlines?.[0]?.formattedNumber,
    jobTitle:  w.jobCode?.shortName,
    hireDate:  w.workerDates?.originalHireDate,
  };
}

// ── Pay statements ────────────────────────────────────────────────────────────

/**
 * Fetch the last 26 pay statements for AWW calculation.
 * Returns an array of { grossPay, regularHours, periodStart, periodEnd }.
 */
async function getPayStatements(associateOID) {
  const client = await adpClient();
  const res = await client.get(`/payroll/v1/workers/${associateOID}/pay-statements`, {
    params: { $top: 26 },
  });

  return (res.data?.payStatements || []).map(ps => ({
    // ADP wraps grossPay as { amount, currencyCode } — handle both shapes
    grossPay:     parseFloat(ps.grossPay?.amount ?? ps.grossPay ?? 0),
    // Regular hours live inside earnings[0].hours in the ADP response
    regularHours: parseFloat(
      ps.earnings?.find(e => e.typeCode?.codeValue === 'REG')?.hours ??
      ps.regularHours ??
      0
    ),
    periodStart:  ps.payPeriodStartDate,
    periodEnd:    ps.payPeriodEndDate,
  }));
}

// ── AWW / TD rate calculation (California LC §4453) ───────────────────────────

/**
 * Calculate Average Weekly Wage and California 2026 TD rate.
 *
 * 2026 TD limits (updated Jan 1, 2026 per integrations.md):
 *   Min: $252.03 / week
 *   Max: $1,680.29 / week
 */
function calculateTDRate(payStatements) {
  if (!payStatements || payStatements.length === 0) {
    throw new Error('Cannot calculate AWW: no pay statements provided');
  }

  const TD_MIN = 252.03;
  const TD_MAX = 1_680.29;

  const totalGross = payStatements.reduce((sum, ps) => sum + ps.grossPay, 0);
  const aww        = totalGross / (payStatements.length * 2);
  const rawTD      = aww * (2 / 3);
  const tdRate     = Math.max(TD_MIN, Math.min(TD_MAX, rawTD));

  return {
    aww:             round2(aww),
    tdRate:          round2(tdRate),
    weeksCalculated: payStatements.length,
    totalGross:      round2(totalGross),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Convenience: pull everything in one call ──────────────────────────────────

/**
 * Fetch employee demographics + pay history, then compute financials.
 * Returns the employee object merged with AWW/TD fields.
 */
async function getEmployeeWithFinancials(adpEmployeeId) {
  const employee     = await getEmployee(adpEmployeeId);
  const payStatements = await getPayStatements(employee.associateOID);
  const financials   = calculateTDRate(payStatements);

  logger.info({
    msg:         'ADP pull complete',
    adpEmployeeId,
    associateOID: employee.associateOID,
    aww:          financials.aww,
    tdRate:       financials.tdRate,
  });

  return { ...employee, ...financials, payStatements };
}

module.exports = {
  getEmployee,
  getPayStatements,
  calculateTDRate,
  getEmployeeWithFinancials,
  _resetTokenCache, // test helper
};
