'use strict';

const express           = require('express');
const { body, param, query, validationResult } = require('express-validator');
const claimService      = require('../services/claimService');
const tdPeriodsService  = require('../services/tdPeriodsService');
const pdfService        = require('../services/pdfService');
const decisionBriefService = require('../services/decisionBriefService');
const { supabase }      = require('../services/supabase');
const db                = require('../services/db');
const logger            = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const { CLAIM_STATUSES, SETTABLE_CLAIM_STATUSES } = require('../constants');

const router = express.Router();

// ── Validation helper ─────────────────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// ── POST /api/v1/claims — Submit FROI / create new claim ──────────────────────
router.post(
  '/',
  requireAuth,
  requireRole(['admin', 'employer']),
  [
    body('adpEmployeeId')
      .notEmpty().withMessage('adpEmployeeId is required'),
    body('employerName')
      .notEmpty().withMessage('employerName is required'),
    body('dateOfInjury')
      .isISO8601().withMessage('dateOfInjury must be a valid date (YYYY-MM-DD)'),
    body('bodyPart')
      .optional().isLength({ max: 100 }).withMessage('bodyPart must be 100 characters or fewer'),
    body('injuryType')
      .optional().isLength({ max: 100 }).withMessage('injuryType must be 100 characters or fewer'),
    body('injuryDescription')
      .isLength({ min: 10 }).withMessage('injuryDescription must be at least 10 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.createClaim(req.body, req.user.employerId || req.user.sub);
      res.status(201).json(claim);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims — List claims ─────────────────────────────────────────
router.get(
  '/',
  requireAuth,
  [
    query('status')
      .optional()
      .isIn(CLAIM_STATUSES)
      .withMessage('Invalid status value'),
  ],
  validate,
  async (req, res) => {
    try {
      const filters = {};

      // Employers only see their own claims; admins can see all or filter by employerId
      if (req.user.role === 'employer') {
        filters.employerId = req.user.employerId || req.user.sub;
      } else if (req.query.employerId) {
        filters.employerId = req.query.employerId;
      }

      if (req.query.status) filters.status = req.query.status;

      const claims = await claimService.listClaims(filters);

      // Inline TD summary per claim — admins use it to render the
      // "Active Benefit" and "TD Weeks" columns on the claims list.
      // TODO: denormalize/cache td_summary when list size > 50.
      const enriched = await Promise.all(
        claims.map(async (c) => {
          try {
            const td_summary = await tdPeriodsService.summary(c.id);
            return { ...c, td_summary };
          } catch (err) {
            logger.warn({ msg: 'claims list: td_summary failed', claimId: c.id, err: err.message });
            return { ...c, td_summary: null };
          }
        })
      );

      res.json({ claims: enriched, count: enriched.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id — Get single claim ─────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      // Employers may only view their own claims
      if (req.user.role === 'employer') {
        const empId = req.user.employerId || req.user.sub;
        if (claim.employerId !== empId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      res.json(claim);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/claims/:id/reserves — Adjuster approves reserves ────────────
router.patch(
  '/:id/reserves',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('medical')
      .isFloat({ min: 0 }).withMessage('medical reserve must be a non-negative number'),
    body('indemnity')
      .isFloat({ min: 0 }).withMessage('indemnity reserve must be a non-negative number'),
    body('expense')
      .isFloat({ min: 0 }).withMessage('expense reserve must be a non-negative number'),
    body('reason')
      .optional()
      .isLength({ min: 3 }).withMessage('reason must be at least 3 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.approveReserves(
        req.params.id,
        {
          medical:   parseFloat(req.body.medical),
          indemnity: parseFloat(req.body.indemnity),
          expense:   parseFloat(req.body.expense),
          reason:    req.body.reason,
        },
        req.user.email
      );
      res.json(claim);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/claims/:id/status — Update claim status ────────────────────
router.patch(
  '/:id/status',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('status')
      .isIn(SETTABLE_CLAIM_STATUSES)
      .withMessage('Invalid target status'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.updateStatus(
        req.params.id,
        req.body.status,
        req.user.email
      );
      res.json(claim);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/analyze — trigger / return AI analysis ────────────
router.post(
  '/:id/analyze',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.triggerAnalysis(req.params.id);
      res.json({ claimId: claim.id, aiAnalysis: claim.aiAnalysis, priority: claim.priority });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/reasoning-pdf — download AI reasoning PDF ──────────
router.get(
  '/:id/reasoning-pdf',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });
      if (!claim.aiAnalysis) return res.status(400).json({ error: 'AI analysis not yet available for this claim' });

      const pdfBuffer = await pdfService.generateReasoningPDF(claim);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="reasoning_${claim.claimNumber || claim.id}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/diaries — list diaries for a claim ────────────────
router.get(
  '/:id/diaries',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const diaries = await claimService.getDiaries(req.params.id);
      res.json({ diaries });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/documents — ingested documents w/ AI summaries ────
router.get(
  '/:id/documents',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('claim_documents').select('*').eq('claim_id', req.params.id);
      if (error) throw new Error(error.message);
      const documents = (data || []).sort((a, b) =>
        String(b.received_at || '').localeCompare(String(a.received_at || '')));
      res.json({ documents });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/documents/:docId/file — open the original ─────────
router.get(
  '/:id/documents/:docId/file',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty(), param('docId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { data } = await supabase
        .from('claim_documents').select('*').eq('id', req.params.docId).single();
      if (!data || data.claim_id !== req.params.id) {
        return res.status(404).json({ error: 'Document not found' });
      }
      const claim = await claimService.getClaim(req.params.id).catch(() => null);
      const pdfBuffer = await pdfService.generateClaimDocumentPDF(data, claim);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${data.id}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/decision-brief — plain-language what/why ──────────
router.get(
  '/:id/decision-brief',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });
      const diaries = await claimService.getDiaries(req.params.id).catch(() => []);
      const { data: documents } = await supabase
        .from('claim_documents').select('*').eq('claim_id', req.params.id);
      const brief = decisionBriefService.buildBrief({ claim, diaries, documents: documents || [] });
      res.json(brief);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/dwc1 — get DWC-1 PDF for a claim ──────────────────
router.get(
  '/:id/dwc1',
  requireAuth,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      // Employer/employee scope check
      if (req.user.role === 'employer') {
        const empId = req.user.employerId || req.user.sub;
        if (claim.employerId !== empId) return res.status(403).json({ error: 'Access denied' });
      }

      const docId = claim.dwc1DocumentId;
      if (!docId) return res.status(404).json({ error: 'DWC-1 not yet generated for this claim' });

      const doc = db.documents.findById(docId);
      if (!doc) return res.status(404).json({ error: 'DWC-1 document record not found' });

      // If we have the PDF buffer in-memory (M2), return it as a download
      if (doc.pdf_buffer_b64) {
        const pdfBuffer = Buffer.from(doc.pdf_buffer_b64, 'base64');
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="dwc1_${claim.claimNumber}.pdf"`);
        return res.send(pdfBuffer);
      }

      // M3+: return Supabase Storage signed URL
      res.json({
        document_id:  doc.id,
        storage_path: doc.storage_path,
        // signed_url: await supabase.storage.createSignedUrl(doc.storage_path, 3600)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/dwc1/request-signature — DocuSign stub ────────────
// M2 placeholder. Logs claim_event so adjuster knows to follow up manually.
// Replace with DocuSign envelope creation in a future milestone.
router.post(
  '/:id/dwc1/request-signature',
  requireAuth,
  requireRole(['employee', 'admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      claim.events.push({
        type:      'dwc1_signature_pending',
        timestamp: new Date().toISOString(),
        data:      {
          requestedBy: req.user.sub,
          note:        'DocuSign not yet integrated — manual follow-up by adjuster required',
        },
      });

      res.json({
        status:  'pending',
        message: 'Your adjuster will contact you to complete your signature.',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/intake-progress — update intake step flags ─────────
router.patch(
  '/:id/intake-progress',
  requireAuth,
  requireRole(['employee', 'admin']),
  [
    param('id').notEmpty(),
    body('step')
      .isIn(['voice_complete', 'media_complete', 'mpn_acknowledged', 'provider_selected', 'appointment_confirmed', 'dwc1_generated'])
      .withMessage('Invalid intake step'),
    body('value').isBoolean().withMessage('value must be a boolean'),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      if (!claim.intakeProgress) {
        claim.intakeProgress = {
          voice_complete: false, media_complete: false, mpn_acknowledged: false,
          provider_selected: false, appointment_confirmed: false, dwc1_generated: false,
        };
      }
      claim.intakeProgress[req.body.step] = req.body.value;
      res.json({ intake_progress: claim.intakeProgress });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
