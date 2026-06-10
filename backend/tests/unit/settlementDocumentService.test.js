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
async function seedMsaDocument(overrides = {}) {
  const row = {
    id: overrides.id || 'doc_msa_1',
    claim_id: overrides.claim_id ?? CLAIM,
    title: overrides.title ?? 'Medicare Set-Aside allocation report',
    category: 'settlement', source: 'upload', status: overrides.status ?? 'filed',
    triage_status: 'none', version: 1,
    received_at: new Date().toISOString(), created_at: new Date().toISOString(),
  };
  await supabase.from('claim_documents').insert(row);
  return row;
}

describe('C&R package — MSA gate at the document boundary', () => {
  it('refuses to generate without an MSA screen', async () => {
    await seedOffer();
    await expect(svc.generateCnRPackage(CLAIM))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_NO_MSA_SCREEN');
  });

  it('refuses when the screen requires an MSA and no document is linked', async () => {
    await seedOffer();
    await seedMsa(true);
    await expect(svc.generateCnRPackage(CLAIM))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_MSA_REQUIRED');
  });

  it("does NOT trust the request's say-so: the legacy msa_included flag alone is refused", async () => {
    await seedOffer();
    await seedMsa(true);
    await expect(svc.generateCnRPackage(CLAIM, { msa_included: true }))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_MSA_REQUIRED');
  });

  it('refuses a linked document that does not exist', async () => {
    await seedOffer();
    await seedMsa(true);
    await expect(svc.generateCnRPackage(CLAIM, { msa_document_id: 'doc_ghost' }))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_MSA_DOCUMENT — linked MSA document not found');
  });

  it('refuses a linked document filed on ANOTHER claim', async () => {
    await seedOffer();
    await seedMsa(true);
    const doc = await seedMsaDocument({ claim_id: 'claim_other' });
    await expect(svc.generateCnRPackage(CLAIM, { msa_document_id: doc.id }))
      .rejects.toThrow('not filed on this claim');
  });

  it('refuses a superseded (non-current) MSA document', async () => {
    await seedOffer();
    await seedMsa(true);
    const doc = await seedMsaDocument({ status: 'superseded' });
    await expect(svc.generateCnRPackage(CLAIM, { msa_document_id: doc.id }))
      .rejects.toThrow('not current');
  });

  it('refuses a linked document that is not identifiable as an MSA', async () => {
    await seedOffer();
    await seedMsa(true);
    const doc = await seedMsaDocument({ title: 'Wage statement Q1' });
    await expect(svc.generateCnRPackage(CLAIM, { msa_document_id: doc.id }))
      .rejects.toThrow('not identifiable as an MSA');
  });

  it('generates with a verified, current MSA document and links it to the package', async () => {
    await seedOffer();
    await seedMsa(true);
    const doc = await seedMsaDocument();
    const result = await svc.generateCnRPackage(CLAIM, { msa_document_id: doc.id });
    expect(result.document.package_kind).toBe('cnr_10214c');
    expect(result.msa_document_id).toBe(doc.id);

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const ev = events.find(e => e.type === 'settlement_package_generated');
    expect(ev.data.msa_document_id).toBe(doc.id);
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

  it('REFUSES generation when the itemized breakdown does not equal the total', async () => {
    await seedOffer({
      cnr_pd_amount: 30000, cnr_medical_amount: 12000,
      cnr_attorney_fee_amount: 7800, cnr_other_amount: 999,
    });
    await seedMsa(false);
    await expect(svc.generateCnRPackage(CLAIM))
      .rejects.toThrow('CNR_PACKAGE_BLOCKED_BREAKDOWN_MISMATCH');

    // Nothing was filed.
    const { data: docs } = await supabase.from('claim_documents').select('*').eq('claim_id', CLAIM);
    expect(docs).toHaveLength(0);
  });

  it('falls back to single-line when breakdown columns are absent', async () => {
    await seedOffer();
    await seedMsa(false);
    const result = await svc.generateCnRPackage(CLAIM);
    expect(result.breakdown.available).toBe(false);
  });

  it('regeneration supersedes the prior version (and records what replaced it)', async () => {
    await seedOffer();
    await seedMsa(false);
    const v1 = await svc.generateCnRPackage(CLAIM);
    const v2 = await svc.generateCnRPackage(CLAIM);
    expect(v2.document.version).toBe(2);

    const { data: prior } = await supabase
      .from('claim_documents').select('*').eq('id', v1.document.id).single();
    expect(prior.status).toBe('superseded');
    expect(prior.superseded_by).toBe(v2.document.id);
  });

  it('ATOMIC replacement: if storing the new version fails, the current version stays filed', async () => {
    await seedOffer();
    await seedMsa(false);
    const v1 = await svc.generateCnRPackage(CLAIM);

    // Inject a one-shot insert failure on claim_documents.
    const realFrom = supabase.from.bind(supabase);
    let armed = true;
    const spy = jest.spyOn(supabase, 'from').mockImplementation((table) => {
      const builder = realFrom(table);
      if (table === 'claim_documents' && armed) {
        const realInsert = builder.insert.bind(builder);
        builder.insert = (data) => {
          if (data && data.package_kind === 'cnr_10214c') {
            armed = false;
            return { select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'injected storage outage' } }) }) };
          }
          return realInsert(data);
        };
      }
      return builder;
    });

    try {
      await expect(svc.generateCnRPackage(CLAIM)).rejects.toThrow('injected storage outage');
      // v1 must NOT have been superseded — there is no v2.
      const { data: prior } = await supabase
        .from('claim_documents').select('*').eq('id', v1.document.id).single();
      expect(prior.status).toBe('filed');
    } finally {
      spy.mockRestore();
    }
  });

  it('long dispute lists paginate instead of drawing off the page', async () => {
    const { PDFDocument } = require('pdf-lib');
    await seedOffer();
    await seedMsa(false);
    // Three dispute kinds repeated through opts → long sections; pad the
    // release scope by repeating disputes to force overflow.
    const result = await svc.generateCnRPackage(CLAIM, {
      disputes: Array.from({ length: 30 }, (_, i) =>
        ['future_medical', 'earnings', 'body_parts'][i % 3]),
    });
    expect(result.document.pages).toBeGreaterThan(1);
    const pdf = await PDFDocument.load(Buffer.from(result.document.pdf_buffer_b64, 'base64'));
    expect(pdf.getPageCount()).toBe(result.document.pages);
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
