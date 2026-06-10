'use strict';

/**
 * Inbound Document Ingestion routes (admin-only).
 *
 *   POST /api/v1/claims/:id/documents/ingest — ingest with a known claim
 *   POST /api/v1/documents/ingest            — ingest, agent resolves the claim
 *   GET  /api/v1/documents/triage            — pending human-triage queue
 *   POST /api/v1/documents/:docId/triage-resolve — file or reject
 *
 * NOTE: mounted BEFORE routes/documents.js so /documents/triage is not
 * swallowed by that router's GET /:id.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const ingestion = require('../services/documentIngestionService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

async function handleIngest(req, res, claimId) {
  try {
    const result = await ingestion.ingestDocument({
      ...req.body,
      claim_id: claimId || req.body.claim_id || null,
    }, req.user?.email);
    res.status(201).json(result);
  } catch (err) {
    const status = /required|must be|cannot be|does not match/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}

router.post(
  '/claims/:id/documents/ingest',
  requireAuth, requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('content_text').notEmpty(),
    body('received_at').optional().isISO8601()
      .withMessage('received_at must be an ISO-8601 timestamp (the channel receipt time)'),
  ],
  validate,
  (req, res) => handleIngest(req, res, req.params.id)
);

router.post(
  '/documents/ingest',
  requireAuth, requireRole(['admin']),
  [
    body('content_text').notEmpty(),
    body('received_at').optional().isISO8601()
      .withMessage('received_at must be an ISO-8601 timestamp (the channel receipt time)'),
  ],
  validate,
  (req, res) => handleIngest(req, res, null)
);

router.get('/documents/triage', requireAuth, requireRole(['admin']), async (_req, res) => {
  try {
    res.json({ documents: await ingestion.listTriage() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post(
  '/documents/:docId/triage-resolve',
  requireAuth, requireRole(['admin']),
  [param('docId').notEmpty(), body('action').isIn(['file', 'reject'])],
  validate,
  async (req, res) => {
    try {
      const result = await ingestion.resolveTriage(req.params.docId, req.body, req.user?.email);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
