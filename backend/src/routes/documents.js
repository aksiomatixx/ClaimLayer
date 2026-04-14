'use strict';

/**
 * Document upload routes — M2 media upload (Issue #7).
 *
 * POST /api/v1/documents/upload-url          — generate signed upload URL
 * POST /api/v1/documents/:id/confirm-upload  — confirm upload, queue FH push
 * GET  /api/v1/documents/:id                 — get document metadata
 */

const express  = require('express');
const { body, param, validationResult } = require('express-validator');
const db       = require('../services/db');
const filehandler = require('../services/filehandler');
const logger   = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime',
];
const MAX_FILE_SIZE = 52_428_800; // 50 MB
const MAX_FILES_PER_CLAIM = 5;

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/documents/upload-url ────────────────────────────────────────
// Creates a document record and returns a signed upload URL.
// In M2 (no real Supabase): returns a mock signed URL and stores metadata.
// In M3: replace mock URL with supabase.storage.from('claim-media').createSignedUploadUrl()
router.post(
  '/upload-url',
  requireAuth,
  requireRole(['employee', 'admin']),
  [
    body('claim_id').notEmpty().withMessage('claim_id is required'),
    body('file_name').notEmpty().withMessage('file_name is required'),
    body('mime_type')
      .notEmpty()
      .custom(v => ALLOWED_MIME_TYPES.includes(v))
      .withMessage(`mime_type must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`),
    body('file_size_bytes')
      .isInt({ min: 1, max: MAX_FILE_SIZE })
      .withMessage(`file_size_bytes must be between 1 and ${MAX_FILE_SIZE} (50MB)`),
  ],
  validate,
  async (req, res) => {
    try {
      const { claim_id, file_name, mime_type, file_size_bytes } = req.body;

      // Enforce 5-file limit
      const existing = db.documents.findByClaim(claim_id).filter(d =>
        ['photo', 'video'].includes(d.doc_type)
      );
      if (existing.length >= MAX_FILES_PER_CLAIM) {
        return res.status(400).json({ error: `Maximum ${MAX_FILES_PER_CLAIM} files per claim` });
      }

      const storagePath = `claims/${claim_id}/media/${Date.now()}_${file_name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const docType     = mime_type.startsWith('video') ? 'video' : 'photo';

      // Create document record before upload
      const doc = db.documents.create({
        claim_id,
        doc_type:   docType,
        source:     'employee_upload',
        storage_path: storagePath,
        file_name,
        mime_type,
        size_bytes: file_size_bytes,
        filehandler_pushed: false,
      });

      // M2: mock signed URL — in M3 replace with Supabase Storage signedUploadUrl
      // The frontend should POST the file to this URL directly
      const upload_url = `${process.env.SUPABASE_URL || 'https://mock-storage.homecaretpa.internal'}/storage/v1/object/${storagePath}?token=mock_signed_${doc.id}`;

      logger.info({ msg: 'documents: upload-url issued', docId: doc.id, claim_id, docType });
      res.json({ upload_url, document_id: doc.id, storage_path: storagePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/documents/:id/confirm-upload ─────────────────────────────────
// Called by frontend after the direct upload to Supabase Storage completes.
// Triggers FileHandler push (async).
router.post(
  '/:id/confirm-upload',
  requireAuth,
  requireRole(['employee', 'admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const doc = db.documents.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      // Async: push to FileHandler
      setImmediate(async () => {
        try {
          // In M3 this reads from Supabase Storage; in M2 we use a placeholder buffer
          const placeholder = Buffer.from(`[Binary content — ${doc.mime_type} — ${doc.storage_path}]`);
          await filehandler.attachDocument(
            null, // claimId — look up from doc.claim_id's filehandlerId in M3
            placeholder,
            doc.doc_type.toUpperCase(),
            `${doc.doc_type} — ${doc.file_name || doc.storage_path}`
          );
          db.documents.update(doc.id, { filehandler_pushed: true });
          logger.info({ msg: 'documents: FH push complete', docId: doc.id });
        } catch (err) {
          logger.error({ msg: 'documents: FH push failed', docId: doc.id, err: err.message });
        }
      });

      db.documents.update(doc.id, { upload_confirmed_at: new Date().toISOString() });
      res.json({ status: 'queued', document_id: doc.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/documents/:id ─────────────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const doc = db.documents.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      // Strip large binary fields from the response
      const { pdf_buffer_b64, ...safeDoc } = doc;
      res.json(safeDoc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
