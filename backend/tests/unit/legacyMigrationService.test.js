'use strict';

/**
 * Unit tests for legacyMigrationService.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase }            = require('../../src/services/supabase');
const legacyMigrationService  = require('../../src/services/legacyMigrationService');

describe('legacyMigrationService', () => {
  beforeEach(() => {
    supabase._resetStore();
  });

  async function seedLegacyClaim(externalId, overrides = {}) {
    await supabase.from('legacy_claims').insert({
      external_id:   externalId,
      claimant_name: overrides.claimant_name || 'Test Claimant',
      employer_name: overrides.employer_name || 'Test Employer',
      doi:           overrides.doi           || '2026-03-15',
      body_part:     overrides.body_part     || 'Shoulder',
      status:        overrides.status        || 'open',
      raw:           overrides.raw           || { injury_type: 'Strain / Sprain' },
    });
  }

  // ── migrateFromLegacy ─────────────────────────────────────────────────────
  describe('migrateFromLegacy', () => {
    it('inserts canonical claim rows with correct source_system + external_claim_id', async () => {
      await seedLegacyClaim('LEG-100');
      const result = await legacyMigrationService.migrateFromLegacy('mock_legacy');

      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.ids).toEqual(['claim_legacy_LEG-100']);

      const { data: claims } = await supabase.from('claims').select('*').eq('id', 'claim_legacy_LEG-100');
      expect(claims).toHaveLength(1);
      expect(claims[0].source_system).toBe('mock_legacy');
      expect(claims[0].external_claim_id).toBe('LEG-100');
      expect(claims[0].sync_status).toBe('migrated');
      expect(claims[0].body_part).toBe('Shoulder');
    });

    it('writes a migrated_from_legacy claim_event', async () => {
      await seedLegacyClaim('LEG-101');
      await legacyMigrationService.migrateFromLegacy('mock_legacy');
      const { data: events } = await supabase
        .from('claim_events').select('*').eq('claim_id', 'claim_legacy_LEG-101');
      expect(events.some(e => e.type === 'migrated_from_legacy')).toBe(true);
      const ev = events.find(e => e.type === 'migrated_from_legacy');
      expect(ev.data.source_system).toBe('mock_legacy');
      expect(ev.data.external_claim_id).toBe('LEG-101');
    });

    it('is idempotent — re-running skips already-migrated claims', async () => {
      await seedLegacyClaim('LEG-102');
      const first  = await legacyMigrationService.migrateFromLegacy('mock_legacy');
      const second = await legacyMigrationService.migrateFromLegacy('mock_legacy');

      expect(first.migrated).toBe(1);
      expect(second.migrated).toBe(0);

      const { data: claims } = await supabase
        .from('claims').select('*').eq('external_claim_id', 'LEG-102');
      expect(claims).toHaveLength(1);
    });

    it('migrates multiple drafts in a single call', async () => {
      await seedLegacyClaim('LEG-200');
      await seedLegacyClaim('LEG-201');
      await seedLegacyClaim('LEG-202');
      const result = await legacyMigrationService.migrateFromLegacy('mock_legacy');
      expect(result.migrated).toBe(3);
      expect(result.ids).toHaveLength(3);
    });

    it('maps legacy status to a valid native status', async () => {
      await seedLegacyClaim('LEG-300', { status: 'open' });
      await seedLegacyClaim('LEG-301', { status: 'in_progress' });
      await seedLegacyClaim('LEG-302', { status: 'pending_review' });
      await seedLegacyClaim('LEG-303', { status: 'unknown_status_value' });

      await legacyMigrationService.migrateFromLegacy('mock_legacy');
      const { data: claims } = await supabase.from('claims').select('*').neq('source_system', 'native');
      const byExt = Object.fromEntries(claims.map(c => [c.external_claim_id, c.status]));

      expect(byExt['LEG-300']).toBe('intake_complete');
      expect(byExt['LEG-301']).toBe('active_medical');
      expect(byExt['LEG-302']).toBe('under_investigation');
      expect(byExt['LEG-303']).toBe('intake_complete'); // fallback
    });

    it('throws on unknown source system', async () => {
      await expect(
        legacyMigrationService.migrateFromLegacy('not_a_real_system')
      ).rejects.toThrow(/Unknown source system/);
    });
  });

  // ── listMigrated ───────────────────────────────────────────────────────────
  describe('listMigrated', () => {
    it('returns only claims with source_system <> native', async () => {
      await supabase.from('claims').insert({
        id: 'native-1', source_system: 'native', body_part: 'X',
      });
      await supabase.from('claims').insert({
        id: 'leg-1', source_system: 'mock_legacy',
        external_claim_id: 'LEG-A', body_part: 'Y',
      });
      const rows = await legacyMigrationService.listMigrated();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('leg-1');
    });

    it('returns empty list when nothing has been migrated', async () => {
      const rows = await legacyMigrationService.listMigrated();
      expect(rows).toEqual([]);
    });
  });
});
