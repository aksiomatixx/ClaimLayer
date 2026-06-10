'use strict';

/**
 * Unit tests — M6 schema constants and controlled-vocabulary validation.
 *
 * These tests do not hit Supabase or any external service.  They validate the
 * controlled-vocabulary constants that must match the CHECK constraints in
 * migration 20260101000005_m6_retrofit.sql.
 */

const {
  CLAIM_STATUSES,
  SUBROGATION_STATUSES,
  DOCUMENT_CATEGORIES,
} = require('../../src/constants');

// ── Claim status ──────────────────────────────────────────────────────────────

describe('CLAIM_STATUSES', () => {
  it('includes future_medical_only as a valid claim status', () => {
    expect(CLAIM_STATUSES).toContain('future_medical_only');
  });

  it('includes all core lifecycle statuses', () => {
    const required = [
      'new_claim', 'intake_complete', 'under_investigation', 'accepted',
      'active_medical', 'p_and_s', 'pd_evaluation', 'settlement_discussions',
      'litigated', 'denied', 'closed',
    ];
    required.forEach(s => expect(CLAIM_STATUSES).toContain(s));
  });
});

// ── Subrogation status ────────────────────────────────────────────────────────

describe('SUBROGATION_STATUSES', () => {
  // Values must match the CHECK constraint in 20260101000005_m6_retrofit.sql
  const ALLOWED = ['not_applicable', 'under_evaluation', 'waived', 'referred', 'recovered'];

  it('contains exactly the values defined in the migration CHECK constraint', () => {
    expect(SUBROGATION_STATUSES.sort()).toEqual(ALLOWED.sort());
  });

  it('accepts under_evaluation (set on MV claim creation)', () => {
    expect(SUBROGATION_STATUSES).toContain('under_evaluation');
  });

  it('accepts not_applicable (default)', () => {
    expect(SUBROGATION_STATUSES).toContain('not_applicable');
  });

  it('rejects values not in the allowed set', () => {
    const invalid = ['pursuing', 'closed', 'pending', 'open', 'resolved', ''];
    invalid.forEach(v => {
      expect(SUBROGATION_STATUSES).not.toContain(v);
    });
  });
});

// ── Document category ─────────────────────────────────────────────────────────

describe('DOCUMENT_CATEGORIES', () => {
  const EXPECTED = [
    'medical',
    'bill',
    'legal',
    'qme',
    'state_form',
    'rfa',
    'pharmacy',
    'correspondence',
    'surveillance',
    'wage',
    'other',
  ];

  it('contains exactly 13 controlled values (11 from M7 + work_status/settlement from Document Ingestion)', () => {
    expect(DOCUMENT_CATEGORIES).toHaveLength(13);
    expect(DOCUMENT_CATEGORIES).toContain('work_status');
    expect(DOCUMENT_CATEGORIES).toContain('settlement');
  });

  it('accepts all 13 controlled category values', () => {
    EXPECTED.forEach(cat => {
      expect(DOCUMENT_CATEGORIES).toContain(cat);
    });
  });

  it('includes rfa as a document category', () => {
    expect(DOCUMENT_CATEGORIES).toContain('rfa');
  });

  it('includes surveillance as a document category', () => {
    expect(DOCUMENT_CATEGORIES).toContain('surveillance');
  });
});
