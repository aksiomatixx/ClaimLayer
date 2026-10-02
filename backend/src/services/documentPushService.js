'use strict';

/**
 * documentPushService — pushes an uploaded media document to FileHandler.
 * Runs as the durable job 'documents.filehandler_push' (src/jobs/registry.js),
 * enqueued by POST /documents/:id/confirm-upload.
 *
 * Idempotent: a document already marked filehandler_pushed is skipped, so a
 * retry after a lost acknowledgement does not attach it twice. A failure
 * throws, and the job queue retries it with backoff.
 */

const db          = require('./db');
const filehandler = require('./filehandler');
const logger      = require('../logger');

async function pushToFileHandler(documentId) {
  const doc = await db.documents.findById(documentId);
  if (!doc) throw new Error(`Document not found: ${documentId}`);
  if (doc.filehandler_pushed) return { skipped: true };

  // In M3 this reads from Supabase Storage; in M2 we use a placeholder buffer
  const placeholder = Buffer.from(`[Binary content — ${doc.mime_type} — ${doc.storage_path}]`);
  await filehandler.attachDocument(
    null, // claimId — look up from doc.claim_id's filehandlerId in M3
    placeholder,
    doc.doc_type.toUpperCase(),
    `${doc.doc_type} — ${doc.file_name || doc.storage_path}`
  );
  await db.documents.update(doc.id, { filehandler_pushed: true });
  logger.info({ msg: 'documents: FH push complete', docId: doc.id });
  return { skipped: false };
}

module.exports = { pushToFileHandler };
