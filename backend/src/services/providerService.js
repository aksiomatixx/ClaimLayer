'use strict';

/**
 * providerService.js — MPN provider search.
 *
 * Wraps db.providers with business logic for sorting, filtering, and
 * pagination. In M3 this will query the providers table in Supabase
 * with PostGIS distance functions — the interface stays identical.
 */

const db     = require('./db');
const logger = require('../logger');

/**
 * Search MPN providers by zip code, specialty, and walk-in status.
 *
 * @param {object} opts
 * @param {string}  opts.zip        Required. Employee zip code for distance sort.
 * @param {string}  [opts.specialty] Optional. One of the specialty values, or 'all'.
 * @param {boolean} [opts.walk_in]  Optional. If true, only walk-in providers.
 * @param {number}  [opts.limit]    Max results to return (default 8).
 * @returns {object[]}  Providers sorted by tier ASC, distance ASC, rating DESC.
 *                      Each has an extra `distance_miles` field.
 */
async function search({ zip, specialty, walk_in, limit = 8 } = {}) {
  if (!zip) throw new Error('zip is required for provider search');

  const results = db.providers.search({ zip, specialty, walk_in });

  logger.info({
    msg:       'providerService: search',
    zip,
    specialty: specialty || 'all',
    walk_in:   walk_in || false,
    returned:  Math.min(results.length, limit),
  });

  return results.slice(0, limit);
}

/**
 * Returns a single provider by ID.
 * Throws 404-style error if not found.
 */
async function getById(providerId) {
  const provider = db.providers.findById(providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  return provider;
}

module.exports = { search, getById };
