'use strict';

/**
 * Unit tests — awardExtractionService (M14.5).
 *
 * aiService._callClaudeWithDocument and pdService.setPAndSDate are stubbed.
 * Supabase is the in-memory mock.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockCallClaudeWithDocument = jest.fn();
jest.mock('../../src/services/aiService', () => ({
  _callClaude:             jest.fn(),
  _callClaudeWithDocument: (...a) => mockCallClaudeWithDocument(...a),
}));

const mockSetPAndSDate = jest.fn().mockResolvedValue({});
jest.mock('../../src/services/pdService', () => ({
  setPAndSDate: (...a) => mockSetPAndSDate(...a),
}));

const awardExtractionService = require('../../src/services/awardExtractionService');
const { supabase } = require('../../src/services/supabase');

const GOOD_EXTRACTION = {
  awardDate:               '2026-05-10',
  awardServiceDate:        '2026-05-15',
  accruedStartDate:        '2026-01-01',
  totalAward:              60_000,
  apportionmentPct:        25,
  weeklyRate:              290,
  aaFeePct:                15,
  aaFeeAmount:             9_000,
  commutationOrdered:      true,
  bodyPartsAwarded:        ['Lumbar Spine'],
  futureMedical:           true,
  rawExtractionConfidence: 92,
  notes:                   'Stip F&A parsed cleanly.',
};

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_aes_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id,
    status:     'pd_evaluation',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  supabase._resetStore();
  mockCallClaudeWithDocument.mockReset();
  mockSetPAndSDate.mockReset();
  mockSetPAndSDate.mockResolvedValue({});
});

describe('extractAward — happy path', () => {
  it('returns the normalized extraction', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockResolvedValueOnce(GOOD_EXTRACTION);

    const result = await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('%PDF-1.4 stub'),
      awardType: 'stip_f_and_a',
    });

    expect(result.awardServiceDate).toBe('2026-05-15');
    expect(result.totalAward).toBe(60_000);
    expect(result.weeklyRate).toBe(290);
    expect(result.commutationOrdered).toBe(true);
  });

  it('writes an ai_decisions row with decision_type=award_extraction', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockResolvedValueOnce(GOOD_EXTRACTION);

    await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('%PDF stub'),
      awardType: 'stip_f_and_a',
    });

    const { data: rows } = await supabase.from('ai_decisions').select('*').eq('claim_id', claimId);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision_type).toBe('award_extraction');
    expect(rows[0].confidence).toBe(92);
  });

  it('calls Claude with the PDF buffer and the awardType instruction', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockResolvedValueOnce(GOOD_EXTRACTION);

    const buf = Buffer.from('%PDF-1.4 test-bytes');
    await awardExtractionService.extractAward({
      claimId, pdfBuffer: buf, awardType: 'cnr_oacr',
    });

    expect(mockCallClaudeWithDocument).toHaveBeenCalledTimes(1);
    const [systemPrompt, pdfBuffer, instruction] = mockCallClaudeWithDocument.mock.calls[0];
    expect(systemPrompt).toContain('workers');
    expect(pdfBuffer).toBe(buf);
    expect(instruction).toContain('cnr_oacr');
  });
});

describe('extractAward — null-tolerance', () => {
  it('normalizes partially-null Claude output without throwing', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockResolvedValueOnce({
      awardDate:               '2026-05-10',
      awardServiceDate:        null,
      accruedStartDate:        null,
      totalAward:              null,
      weeklyRate:              null,
      rawExtractionConfidence: 40,
    });

    const result = await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    });

    expect(result.awardServiceDate).toBeNull();
    expect(result.totalAward).toBeNull();
    expect(Array.isArray(result.bodyPartsAwarded)).toBe(true);
    expect(result.commutationOrdered).toBe(false);
    expect(result.futureMedical).toBe(false);
  });
});

describe('extractAward — error paths', () => {
  it('throws EXTRACTION_FAILED when Claude call rejects', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockRejectedValueOnce(new Error('Claude returned invalid JSON'));

    await expect(awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    })).rejects.toThrow('EXTRACTION_FAILED');
  });

  it('throws EXTRACTION_FAILED on non-object Claude output', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockResolvedValueOnce('not-json');

    await expect(awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    })).rejects.toThrow('EXTRACTION_FAILED');
  });

  it('rejects an invalid awardType', async () => {
    await expect(awardExtractionService.extractAward({
      claimId:   'c1',
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'bogus',
    })).rejects.toThrow();
  });

  it('rejects a non-Buffer pdfBuffer', async () => {
    await expect(awardExtractionService.extractAward({
      claimId:   'c1',
      pdfBuffer: 'not-a-buffer',
      awardType: 'stip_f_and_a',
    })).rejects.toThrow();
  });
});

describe('extractAward — P&S write-through', () => {
  it('triggers setPAndSDate when claim.p_and_s_date is NULL', async () => {
    const claimId = await seedClaim({ p_and_s_date: null });
    mockCallClaudeWithDocument.mockResolvedValueOnce(GOOD_EXTRACTION);

    await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    });

    expect(mockSetPAndSDate).toHaveBeenCalledTimes(1);
    expect(mockSetPAndSDate).toHaveBeenCalledWith(
      claimId,
      expect.objectContaining({ date: '2026-01-01', source: 'award_document' }),
    );
  });

  it('does NOT trigger setPAndSDate when claim.p_and_s_date is already set', async () => {
    const claimId = await seedClaim({ p_and_s_date: '2026-01-01', p_and_s_source: 'pr_4' });
    mockCallClaudeWithDocument.mockResolvedValueOnce(GOOD_EXTRACTION);

    await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    });

    expect(mockSetPAndSDate).not.toHaveBeenCalled();
  });

  it('surfaces P_AND_S_DISCREPANCY when existing date differs by >3 days', async () => {
    const claimId = await seedClaim({ p_and_s_date: '2026-02-01', p_and_s_source: 'pr_4' });
    mockCallClaudeWithDocument.mockResolvedValueOnce({
      ...GOOD_EXTRACTION,
      accruedStartDate: '2026-02-15', // 14-day delta
    });

    const result = await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    });

    expect(result.warnings).toContain('P_AND_S_DISCREPANCY');
  });

  it('no P_AND_S_DISCREPANCY when dates differ by <=3 days', async () => {
    const claimId = await seedClaim({ p_and_s_date: '2026-02-01', p_and_s_source: 'pr_4' });
    mockCallClaudeWithDocument.mockResolvedValueOnce({
      ...GOOD_EXTRACTION,
      accruedStartDate: '2026-02-03', // 2-day delta
    });

    const result = await awardExtractionService.extractAward({
      claimId,
      pdfBuffer: Buffer.from('pdf'),
      awardType: 'stip_f_and_a',
    });

    expect(result.warnings || []).not.toContain('P_AND_S_DISCREPANCY');
  });
});
