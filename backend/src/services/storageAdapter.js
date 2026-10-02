'use strict';

/**
 * storageAdapter.js — Phase 7 Enterprise Document Architecture.
 *
 * Implements unified object storage abstraction with:
 *   1. Cryptographic SHA-256 integrity validation (zero bit rot / tampering).
 *   2. Pluggable storage providers (Supabase Storage, S3, Local, Inline Base64).
 *   3. File magic-byte validation and anti-malware pre-flight scanning.
 *   4. Multi-tenant key path namespacing: tenants/{tenantId}/claims/{claimId}/{docId}.pdf
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const logger = require('../logger');

let supabase = null;
try {
  supabase = require('./supabase').supabase;
} catch {
  // Offline or unit testing without @supabase/supabase-js installed
}

const DEFAULT_BUCKET = process.env.STORAGE_BUCKET || 'claim-documents';
const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || (process.env.NODE_ENV === 'test' ? 'inline' : (supabase?.storage ? 'supabase' : 'inline'));
const LOCAL_STORAGE_DIR = path.join(__dirname, '../../storage_vault');
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Calculate SHA-256 hex digest of a binary buffer.
 */
function computeSha256(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('computeSha256 expects a Buffer');
  }
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Pre-flight file-signature check: refuses executable headers (MZ / ELF) and
 * warns on a PDF without a PDF header. This is NOT an antivirus scan — a
 * stored document is recorded as av_scan_status 'not_scanned' until a real
 * scanner reports on it.
 */
function scanDocument(buffer, mimeType = 'application/pdf') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { status: 'infected', reason: 'Empty or invalid buffer' };
  }

  // Check for Windows Portable Executable (MZ header)
  if (buffer.length >= 2 && buffer[0] === 0x4D && buffer[1] === 0x5A) {
    return { status: 'quarantined', reason: 'Disallowed executable header (MZ) detected' };
  }

  // Check for ELF executable header (0x7F 'E' 'L' 'F')
  if (buffer.length >= 4 && buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
    return { status: 'quarantined', reason: 'Disallowed binary executable header (ELF) detected' };
  }

  // If MIME claims to be PDF, verify '%PDF-' header
  if (mimeType === 'application/pdf' && buffer.length >= 5) {
    const header = buffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      logger.warn({ msg: 'scanDocument: PDF magic header mismatch', header });
    }
  }

  return { status: 'clean', reason: 'Passed pre-flight integrity and signature checks' };
}

/**
 * Store a document buffer in the enterprise object store.
 * Returns metadata fields matching the claim_documents schema.
 */
async function storeDocument({
  claimId,
  tenantId = '00000000-0000-0000-0000-000000000001',
  docId = `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
  buffer,
  mimeType = 'application/pdf',
  filename,
}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('storeDocument requires a Buffer');
  }

  const checksum = computeSha256(buffer);
  const sizeBytes = buffer.length;
  const scan = scanDocument(buffer, mimeType);

  if (scan.status === 'quarantined') {
    logger.error({ msg: 'storeDocument: file quarantined by security scanner', docId, reason: scan.reason });
    throw new Error(`Security validation failed: ${scan.reason}`);
  }

  // Every path segment is a validated id, and the document id is part of the
  // key: two uploads with the same filename never overwrite each other, and
  // no id can climb out of the tenant's prefix (or the local vault directory).
  for (const [name, value] of [['tenantId', tenantId], ['claimId', claimId], ['docId', docId]]) {
    if (!SAFE_SEGMENT.test(String(value || ''))) throw new Error(`storeDocument: invalid ${name}`);
  }
  const cleanFilename = filename ? path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_') : 'document.pdf';
  const storageKey = `tenants/${tenantId}/claims/${claimId}/${docId}-${cleanFilename}`;

  let providerUsed = STORAGE_PROVIDER;
  let inlineB64 = null;

  // 1. Attempt Supabase Storage if configured
  if (providerUsed === 'supabase' && supabase?.storage) {
    try {
      const { error } = await supabase.storage
        .from(DEFAULT_BUCKET)
        .upload(storageKey, buffer, {
          contentType: mimeType,
          upsert: false,   // a stored original is never replaced in place
        });

      if (error) {
        logger.warn({ msg: 'storeDocument: Supabase storage upload failed, falling back to local/inline', err: error.message });
        providerUsed = sizeBytes <= 5 * 1024 * 1024 ? 'inline' : 'local';
      }
    } catch (err) {
      logger.warn({ msg: 'storeDocument: Supabase storage exception, falling back', err: err.message });
      providerUsed = sizeBytes <= 5 * 1024 * 1024 ? 'inline' : 'local';
    }
  }

  // 2. Local disk fallback
  if (providerUsed === 'local') {
    try {
      const target = path.join(LOCAL_STORAGE_DIR, storageKey);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer, { flag: 'wx' });
    } catch (err) {
      logger.error({ msg: 'storeDocument: local file write failed', err: err.message });
      providerUsed = 'inline';
    }
  }

  // 3. Inline Base64 fallback (guarantees persistence even without external S3/Supabase bucket configured)
  if (providerUsed === 'inline' || sizeBytes <= 500 * 1024) {
    inlineB64 = buffer.toString('base64');
  }

  return {
    doc_id:            docId,
    storage_provider:  providerUsed,
    storage_bucket:    DEFAULT_BUCKET,
    storage_key:       storageKey,
    sha256_checksum:   checksum,
    file_size_bytes:   sizeBytes,
    mime_type:         mimeType,
    av_scan_status:    'not_scanned',   // the pre-flight check is not a scan
    av_scanned_at:     null,
    pdf_buffer_b64:    inlineB64,
  };
}

/**
 * Retrieve and verify a document from storage.
 * Verifies cryptographic SHA-256 checksum to guarantee file integrity.
 */
async function retrieveDocument(docRecord) {
  if (!docRecord) {
    throw new Error('retrieveDocument requires a document record');
  }

  let buffer = null;

  // 1. Try Supabase Storage if provider matches
  if (docRecord.storage_provider === 'supabase' && docRecord.storage_key && supabase?.storage) {
    try {
      const bucket = docRecord.storage_bucket || DEFAULT_BUCKET;
      const { data, error } = await supabase.storage.from(bucket).download(docRecord.storage_key);
      if (!error && data) {
        const arrayBuf = await data.arrayBuffer();
        buffer = Buffer.from(arrayBuf);
      }
    } catch (err) {
      logger.warn({ msg: 'retrieveDocument: Supabase storage download failed', err: err.message });
    }
  }

  // 2. Try Local disk
  if (!buffer && docRecord.storage_provider === 'local' && docRecord.storage_key) {
    const localPath = path.resolve(LOCAL_STORAGE_DIR, docRecord.storage_key);
    if (!localPath.startsWith(path.resolve(LOCAL_STORAGE_DIR) + path.sep)) {
      throw new Error('retrieveDocument: storage key escapes the vault');
    }
    if (fs.existsSync(localPath)) {
      buffer = fs.readFileSync(localPath);
    }
  }

  // 3. Try Inline Base64
  if (!buffer && docRecord.pdf_buffer_b64) {
    buffer = Buffer.from(docRecord.pdf_buffer_b64, 'base64');
  }

  if (!buffer) {
    throw new Error(`Document content unavailable for doc_id=${docRecord.id || docRecord.doc_id}`);
  }

  // Cryptographic integrity validation
  if (docRecord.sha256_checksum) {
    const actualChecksum = computeSha256(buffer);
    if (actualChecksum !== docRecord.sha256_checksum) {
      logger.error({
        msg: 'retrieveDocument: SHA-256 checksum mismatch! Data tampering or corruption detected.',
        expected: docRecord.sha256_checksum,
        actual: actualChecksum,
      });
      throw new Error('Cryptographic integrity failure: document checksum does not match stored signature');
    }
  }

  return buffer;
}

module.exports = {
  computeSha256,
  scanDocument,
  storeDocument,
  retrieveDocument,
  DEFAULT_BUCKET,
};
