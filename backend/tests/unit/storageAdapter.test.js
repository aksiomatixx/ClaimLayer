'use strict';

const storageAdapter = require('../../src/services/storageAdapter');

describe('storageAdapter (Phase 7 — Enterprise Document Architecture)', () => {
  const samplePdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Title (Test DWC-1) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
  const sampleMaliciousExe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ header

  test('computes cryptographic SHA-256 hash', () => {
    const hash1 = storageAdapter.computeSha256(samplePdf);
    const hash2 = storageAdapter.computeSha256(samplePdf);

    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
  });

  test('scans and approves legitimate PDF file', () => {
    const scan = storageAdapter.scanDocument(samplePdf, 'application/pdf');
    expect(scan.status).toBe('clean');
  });

  test('quarantines files with embedded executable PE/MZ header', () => {
    const scan = storageAdapter.scanDocument(sampleMaliciousExe, 'application/pdf');
    expect(scan.status).toBe('quarantined');
    expect(scan.reason).toContain('MZ');
  });

  test('stores document and returns valid metadata schema with inline b64 fallback', async () => {
    const result = await storageAdapter.storeDocument({
      claimId: 'CLM-2026-0099',
      tenantId: '00000000-0000-0000-0000-000000000001',
      docId: 'doc_test_123',
      buffer: samplePdf,
      mimeType: 'application/pdf',
      filename: 'sample_dwc1.pdf',
    });

    expect(result.doc_id).toBe('doc_test_123');
    expect(result.sha256_checksum).toHaveLength(64);
    expect(result.file_size_bytes).toBe(samplePdf.length);
    expect(result.av_scan_status).toBe('clean');
    expect(result.storage_key).toContain('tenants/00000000-0000-0000-0000-000000000001/claims/CLM-2026-0099');
    expect(result.pdf_buffer_b64).toBeTruthy();
  });

  test('retrieves document and verifies SHA-256 integrity', async () => {
    const checksum = storageAdapter.computeSha256(samplePdf);
    const docRecord = {
      doc_id: 'doc_123',
      storage_provider: 'inline',
      sha256_checksum: checksum,
      pdf_buffer_b64: samplePdf.toString('base64'),
    };

    const retrieved = await storageAdapter.retrieveDocument(docRecord);
    expect(retrieved).toEqual(samplePdf);
  });

  test('throws error on cryptographic checksum mismatch (tamper detection)', async () => {
    const docRecord = {
      doc_id: 'doc_tampered',
      storage_provider: 'inline',
      sha256_checksum: 'a'.repeat(64), // fake checksum
      pdf_buffer_b64: samplePdf.toString('base64'),
    };

    await expect(storageAdapter.retrieveDocument(docRecord)).rejects.toThrow(
      /Cryptographic integrity failure/
    );
  });
});
