'use strict';

const { parseAckFlatFile, IAIABC_ERROR_CODES, IAIABC_DN_NAMES } = require('../../src/services/wcisAckParser');

describe('wcisAckParser (Phase 7 — WCIS Release 3.1 EDI Ingestion)', () => {
  test('parses pipe-delimited IAIABC 3.1 EDI acknowledgment batch', () => {
    const rawEdi = [
      'HD|943210987|680282468|20261005|1430|3.1',
      'TA|CLM-2026-0042|00|TA|JCN998877665|||',
      'TE|CLM-2026-0043|00|TE|JCN998877666|057|DN0016|Mandatory employer FEIN missing',
      'TR|CLM-2026-0044|04|TR||028|DN0042|Invalid Social Security Number',
      'TR|3',
    ].join('\n');

    const parsed = parseAckFlatFile(rawEdi);

    expect(parsed.header).toEqual({
      recordType: 'HD',
      senderFein: '943210987',
      receiverFein: '680282468',
      transDate: '20261005',
      transTime: '1430',
      version: '3.1',
    });

    expect(parsed.records).toHaveLength(3);

    // Record 1: TA (Accepted)
    const rec1 = parsed.records[0];
    expect(rec1.claimAdminClaimNumber).toBe('CLM-2026-0042');
    expect(rec1.result).toBe('accepted');
    expect(rec1.jcn).toBe('JCN998877665');
    expect(rec1.errors).toHaveLength(0);

    // Record 2: TE (Accepted with error)
    const rec2 = parsed.records[1];
    expect(rec2.claimAdminClaimNumber).toBe('CLM-2026-0043');
    expect(rec2.result).toBe('accepted_with_error');
    expect(rec2.jcn).toBe('JCN998877666');
    expect(rec2.errors).toHaveLength(1);
    expect(rec2.errors[0].code).toBe('057');
    expect(rec2.errors[0].field).toBe('Employer FEIN');

    // Record 3: TR (Rejected)
    const rec3 = parsed.records[2];
    expect(rec3.claimAdminClaimNumber).toBe('CLM-2026-0044');
    expect(rec3.result).toBe('rejected');
    expect(rec3.errors[0].code).toBe('028');
    expect(rec3.errors[0].field).toBe('Employee SSN');
    expect(rec3.errors[0].description).toBe('Invalid Social Security Number');

    // Summary
    expect(parsed.summary).toEqual({
      total: 3,
      accepted: 1,
      accepted_with_error: 1,
      rejected: 1,
      overallStatus: 'partial',
    });
  });

  test('parses fixed-width IAIABC 3.1 EDI acknowledgment records', () => {
    // Positional format:
    // 0-2: HD, 2-11: SenderFEIN, 11-20: ReceiverFEIN, 20-28: Date, 28-34: Time, 34-37: 3.1
    // Detail: 0-2: TA, 2-4: TA, 4-24: ClaimNum, 24-26: MTC, 26-40: JCN
    const headerLine = 'HD943210987680282468202610051430003.1';
    const detailLine = 'TATA' + 'CLM-2026-0099       ' + '00' + 'JCN123456789  ';
    const rawFixed = `${headerLine}\n${detailLine}\nTR000001`;

    const parsed = parseAckFlatFile(rawFixed);

    expect(parsed.header.senderFein).toBe('943210987');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].claimAdminClaimNumber).toBe('CLM-2026-0099');
    expect(parsed.records[0].result).toBe('accepted');
    expect(parsed.records[0].jcn).toBe('JCN123456789');
  });

  test('throws error on empty content', () => {
    expect(() => parseAckFlatFile('')).toThrow(/parseAckFlatFile requires raw text content/);
  });

  test('a short rejection record is a rejection, not the trailer (both use record type TR)', () => {
    const parsed = parseAckFlatFile([
      'HD|943210987|680282468|20261005|1430|3.1',
      'TR|C1|00|TR|||',            // 16 characters: once mistaken for the trailer
      'TR|7|04',                  // numeric claim number, still a detail record
      'TR|2',
    ].join('\n'));
    expect(parsed.records.map(r => [r.claimAdminClaimNumber, r.result])).toEqual([['C1', 'rejected'], ['7', 'rejected']]);
    expect(parsed.trailer).toEqual({ recordType: 'TR', recordCount: 2 });
    expect(parsed.summary.rejected).toBe(2);

    const fixed = parseAckFlatFile(['HD943210987680282468202610051430', 'TRTRC1                  00', 'TR000001'].join('\n'));
    expect(fixed.records).toHaveLength(1);
    expect(fixed.records[0]).toMatchObject({ claimAdminClaimNumber: 'C1', result: 'rejected' });
    expect(fixed.trailer.recordCount).toBe(1);
  });
});
