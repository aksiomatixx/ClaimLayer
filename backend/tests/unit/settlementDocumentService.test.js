'use strict';

/**
 * Unit tests — Settlement Form Generation.
 *
 * The MSA gate at the document boundary, breakdown assembly +
 * sum-validation from the M22A columns, versioning/supersede, and the
 * representation-aware signature blocks.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/settlementDocumentService');

const CLAIM = 'claim_settle_test';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-S-1', status: 'settlement_discussions',
    date_of_injury: '2026-01-15', employer_id: 'emp-1',
    attorney_represented: false,
    employee: { firstName: 'Settle', lastName: 'Worker' },
  });
});

async function seedOffer(overrides = {}) {
  await supabase.from('settlement_offers').insert({
    id: 'so-1', claim_id: CLAIM, offer_type: 'cnr',
    stip_value: 40000, cnr_value: 52000, status: 'offered',
    created_at: new Date().toISOString(), ...overrides,
  });
}
async function seedMsa(msaRequired = false) {
  await supabase.from('msa_screenings').insert({
    id: 'msa-1', claim_id: CLAIM, msa_required: msaRequired,
    screened_at: new Date().toISOString(),
  });
}

describe('C&R package — MSA gate at the document boundary', () => {
  it('refuses to generate without an MSA screen', async () => {
    await seedOffer();
    await expect(svc.generateCnRPackage(CLAIM))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_NO_MSA_SCREEN');
  });

  it('refuses when the screen requires an MSA and none is included', async () => {
    await seedOffer();
    await seedMsa(true);
    await expect(svc.generateCnRPackage(CLAIM))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_MSA_REQUIRED');
  });

  it('generates when the screen requires an MSA and the adjuster confirms inclusion', async () => {
    await seedOffer();
    await seedMsa(true);
    const result = await svc.generateCnRPackage(CLAIM, { msa_included: true });
    expect(result.document.package_kind).toBe('cnr_10214c');
  });

  it('refuses without a priced offer', async () => {
    await seedMsa(false);
    await expect(svc.generateCnRPackage(CLAIM)).rejects.toThrow('No settlement offer');
  });
});

describe('C&R package — assembly', () => {
  it('produces a DRAFT-flagged versioned PDF filed under category settlement', async () => {
    await seedOffer();
    await seedMsa(false);
    const result = await svc.generateCnRPackage(CLAIM);

    expect(result.draft).toBe(true);
    expect(result.document.category).toBe('settlement');
    expect(result.document.version).toBe(1);
    expect(result.document.title).toContain('(v1)');
    const pdf = Buffer.from(result.document.pdf_buffer_b64, 'base64');
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'settlement_package_generated')).toBe(true);
  });

  it('uses the M22A breakdown when present and validates the sum', async () => {
    await seedOffer({
      cnr_pd_amount: 30000, cnr_medical_amount: 12000,
      cnr_attorney_fee_amount: 7800, cnr_other_amount: 2200,
      cnr_breakdown_source: 'estimate',
    });
    await seedMsa(false);
    const result = await svc.generateCnRPackage(CLAIM);
    expect(result.breakdown.available).toBe(true);
    expect(result.breakdown.sumMatches).toBe(true); // 30000+12000+7800+2200 = 52000
  });

  it('flags a breakdown that does not sum to the C&R value', async () => {
    await seedOffer({
      cnr_pd_amount: 30000, cnr_medical_amount: 12000,
      cnr_attorney_fee_amount: 7800, cnr_other_amount: 999,
    });
    await seedMsa(false);
    const result = await svc.generateCnRPackage(CLAIM);
    expect(result.breakdown.sumMatches).toBe(false);
  });

  it('falls back to single-line when breakdown columns are absent', async () => {
    await seedOffer();
    await seedMsa(false);
    const result = await svc.generateCnRPackage(CLAIM);
    expect(result.breakdown.available).toBe(false);
  });

  it('regeneration supersedes the prior version', async () => {
    await seedOffer();
    await seedMsa(false);
    const v1 = await svc.generateCnRPackage(CLAIM);
    const v2 = await svc.generateCnRPackage(CLAIM);
    expect(v2.document.version).toBe(2);

    const { data: prior } = await supabase
      .from('claim_documents').select('*').eq('id', v1.document.id).single();
    expect(prior.status).toBe('superseded');
  });

  it('reflects representation in the result', async () => {
    await supabase.from('claims').update({
      attorney_represented: true, attorney_name: 'L. Counsel',
    }).eq('id', CLAIM);
    await seedOffer();
    await seedMsa(false);
    const result = await svc.generateCnRPackage(CLAIM);
    expect(result.represented).toBe(true);
  });
});

describe('Stip package — 10214(a)', () => {
  async function seedStip(overrides = {}) {
    await supabase.from('stipulations').insert({
      id: 'stip-1', claim_id: CLAIM, pd_percent: 12, pd_total_value: 14930,
      future_medical: true, future_medical_desc: 'PRN orthopedic care',
      body_parts_accepted: ['Lumbar Spine'], status: 'draft',
      created_at: new Date().toISOString(), ...overrides,
    });
  }

  it('assembles the stipulated award with open future medical', async () => {
    await seedStip();
    const result = await svc.generateStipPackage(CLAIM);
    expect(result.document.package_kind).toBe('stip_10214a');
    expect(result.draft).toBe(true);
    expect(result.stipulation_id).toBe('stip-1');
  });

  it('refuses without a stipulation on file', async () => {
    await expect(svc.generateStipPackage(CLAIM)).rejects.toThrow('No stipulation on file');
  });

  it('stip and C&R packages version independently', async () => {
    await seedStip();
    await seedOffer();
    await seedMsa(false);
    const stipPkg = await svc.generateStipPackage(CLAIM);
    const cnrPkg  = await svc.generateCnRPackage(CLAIM);
    expect(stipPkg.document.version).toBe(1);
    expect(cnrPkg.document.version).toBe(1);
  });
});

describe('standard-language library', () => {
  it('every entry is explicitly draft-flagged until verified sources land', () => {
    for (const [key, entry] of Object.entries(svc.STANDARD_LANGUAGE)) {
      expect(entry.draft).toBe(true);
      expect(entry.text.length).toBeGreaterThan(20);
    }
  });
});
