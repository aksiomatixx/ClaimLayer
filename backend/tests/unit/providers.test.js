'use strict';

/**
 * Unit tests for services/providerService.js
 *
 * Tests run entirely against the in-memory db.js seed — no network required.
 */

const providerService = require('../../src/services/providerService');
const db              = require('../../src/services/db');

afterEach(() => {
  db._reset();
});

// ── search() ──────────────────────────────────────────────────────────────────
describe('providerService.search()', () => {
  it('requires zip', async () => {
    await expect(providerService.search({})).rejects.toThrow('zip is required');
  });

  it('returns at most the default limit (8) providers', async () => {
    const results = await providerService.search({ zip: '90010' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it('returns only accepting_new_wc providers', async () => {
    const results = await providerService.search({ zip: '90010' });
    results.forEach(p => expect(p.accepting_new_wc).toBe(true));
  });

  it('attaches distance_miles to each result', async () => {
    const results = await providerService.search({ zip: '90010' });
    results.forEach(p => {
      expect(typeof p.distance_miles).toBe('number');
      expect(p.distance_miles).toBeGreaterThanOrEqual(0);
    });
  });

  it('sorts by tier ASC then distance ASC', async () => {
    const results = await providerService.search({ zip: '90010', limit: 15 });
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      if (prev.mpn_tier === curr.mpn_tier) {
        // Within same tier, distance should be non-decreasing
        expect(curr.distance_miles).toBeGreaterThanOrEqual(prev.distance_miles - 0.1); // 0.1 tolerance
      } else {
        // Lower tier numbers come first
        expect(curr.mpn_tier).toBeGreaterThanOrEqual(prev.mpn_tier);
      }
    }
  });

  it('filters by specialty', async () => {
    const results = await providerService.search({
      zip: '90010',
      specialty: 'Orthopedic Surgery',
      limit: 15,
    });
    expect(results.length).toBeGreaterThan(0);
    results.forEach(p => expect(p.specialty).toBe('Orthopedic Surgery'));
  });

  it("specialty 'all' returns all specialties", async () => {
    const all      = await providerService.search({ zip: '90010', specialty: 'all', limit: 15 });
    const filtered = await providerService.search({ zip: '90010', specialty: 'Occupational Medicine', limit: 15 });
    expect(all.length).toBeGreaterThan(filtered.length);
  });

  it('filters walk_in=true to only walk-in providers', async () => {
    const results = await providerService.search({ zip: '90010', walk_in: true, limit: 15 });
    expect(results.length).toBeGreaterThan(0);
    results.forEach(p => expect(p.walk_in).toBe(true));
  });

  it('respects custom limit', async () => {
    const results = await providerService.search({ zip: '90010', limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('distance is smaller for closer zip code', async () => {
    // 90010 has providers in the same zip (distance 0).
    // 91301 (Agoura Hills) has no seeded providers — nearest are in 93021 (~8+ miles).
    const near = await providerService.search({ zip: '90010', limit: 15 });
    const far  = await providerService.search({ zip: '91301', limit: 15 });

    const nearMinDist = Math.min(...near.map(p => p.distance_miles));
    const farMinDist  = Math.min(...far.map(p => p.distance_miles));
    expect(farMinDist).toBeGreaterThan(nearMinDist);
  });

  it('returns at least 3 walk-in providers in seed data', async () => {
    const walkIn = await providerService.search({ zip: '90010', walk_in: true, limit: 20 });
    expect(walkIn.length).toBeGreaterThanOrEqual(3);
  });

  it('returns at least 3 tier-1 providers in seed data', async () => {
    const all    = await providerService.search({ zip: '90010', limit: 20 });
    const tier1  = all.filter(p => p.mpn_tier === 1);
    expect(tier1.length).toBeGreaterThanOrEqual(3);
  });
});

// ── getById() ─────────────────────────────────────────────────────────────────
describe('providerService.getById()', () => {
  it('returns the provider matching the ID', async () => {
    // Get a known provider ID from the seed
    const [first] = await providerService.search({ zip: '90010', limit: 1 });
    const found   = await providerService.getById(first.id);
    expect(found.id).toBe(first.id);
    expect(found.name).toBe(first.name);
  });

  it('throws a not-found error for unknown IDs', async () => {
    await expect(providerService.getById('prov_does_not_exist')).rejects.toThrow('not found');
  });
});
