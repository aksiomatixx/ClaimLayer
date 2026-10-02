'use strict';

const express           = require('express');
const { body, param, query, validationResult } = require('express-validator');
const claimService      = require('../services/claimService');
const tdPeriodsService  = require('../services/tdPeriodsService');
const pdfService        = require('../services/pdfService');
const decisionBriefService = require('../services/decisionBriefService');
const { supabase }      = require('../services/supabase');
const config            = require('../config');
const db                = require('../services/db');
const logger            = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireClaimScope } = require('../middleware/claimAccess');
const { humanPrincipal }    = require('../policy/principal');
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
  requireRole(['admin', 'employer']),
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

      // Multi-tenancy isolation: filter by caller tenant when scoped
      if (req.user.tenantId) {
        filters.tenantId = req.user.tenantId;
      }

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
  requireClaimScope('params.id'),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });
      if (req.user?.tenantId && claim.tenantId && claim.tenantId !== req.user.tenantId) {
        return res.status(404).json({ error: 'Claim not found' });
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
        req.user.email,
        { actor: humanPrincipal(req.user) }
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
        req.user.email,
        { actor: humanPrincipal(req.user) }
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
  requireRole(['admin', 'supervisor']), // supervisors: read-only oversight (daily alert drawer links)
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

// ── POST /api/v1/claims/:id/settlement-package — generate 10214 package ──────
router.post(
  '/:id/settlement-package',
  requireAuth,
  requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('kind').isIn(['cnr', 'stip']),
    body('msa_document_id').optional().isString().isLength({ min: 1, max: 120 })
      .withMessage('msa_document_id must be the id of the filed MSA document'),
    body('disputes').optional().isArray().withMessage('disputes must be an array'),
    body('disputes.*').optional().isIn(['future_medical', 'earnings', 'body_parts'])
      .withMessage('disputes entries must be future_medical, earnings, or body_parts'),
  ],
  validate,
  async (req, res) => {
    try {
      const settlementDocs = require('../services/settlementDocumentService');
      const result = req.body.kind === 'cnr'
        ? await settlementDocs.generateCnRPackage(req.params.id, {
            msa_document_id: req.body.msa_document_id,
            disputes: req.body.disputes,
          })
        : await settlementDocs.generateStipPackage(req.params.id);
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404
        : err.message.includes('BLOCKED') || err.message.includes('No ') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/representation — set/clear attorney (M17B) ───────
router.post(
  '/:id/representation',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty(), body('represented').isBoolean()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.setAttorneyRepresentation(
        req.params.id,
        { represented: req.body.represented, attorney: req.body.attorney },
        req.user?.email,
        { actor: humanPrincipal(req.user) }
      );
      res.json({ claim });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/reopen — reopen a closed claim (M17B) ────────────
router.post(
  '/:id/reopen',
  requireAuth,
  requireRole(['admin']),
  [param('id').notEmpty(), body('reason').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.reopenClaim(req.params.id, req.body.reason, req.user?.email,
        { actor: humanPrincipal(req.user) });
      res.json({ claim });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/documents — ingested documents w/ AI summaries ────
router.get(
  '/:id/documents',
  requireAuth,
  requireRole(['admin', 'supervisor']), // supervisors: read-only oversight (daily alert drawer links)
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('claim_documents').select('*').eq('claim_id', req.params.id);
      if (error) throw new Error(error.message);
      // List responses carry metadata only — the raw PDF (base64, up to
      // ~20 MB per document) is served exclusively by the explicit
      // /documents/:docId/file download route.
      const documents = (data || [])
        .map(({ pdf_buffer_b64, ...doc }) => ({ ...doc, has_file: !!pdf_buffer_b64 }))
        .sort((a, b) =>
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
  requireRole(['admin', 'supervisor']), // supervisors: read-only oversight (daily alert drawer links)
  [param('id').notEmpty(), param('docId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { data } = await supabase
        .from('claim_documents').select('*').eq('id', req.params.docId).single();
      if (!data || data.claim_id !== req.params.id) {
        return res.status(404).json({ error: 'Document not found' });
      }
      // Retrieve binary via enterprise storage adapter (verifying SHA-256 integrity),
      // with fallback to inline rendition if text-only.
      let pdfBuffer = null;
      if (data.storage_key || data.pdf_buffer_b64) {
        try {
          const storageAdapter = require('../services/storageAdapter');
          pdfBuffer = await storageAdapter.retrieveDocument(data);
        } catch (storageErr) {
          logger.warn({ msg: 'storageAdapter retrieval failed, using fallback', err: storageErr.message });
          if (data.pdf_buffer_b64) {
            pdfBuffer = Buffer.from(data.pdf_buffer_b64, 'base64');
          }
        }
      }

      if (!pdfBuffer) {
        const claim = await claimService.getClaim(req.params.id).catch(() => null);
        pdfBuffer = await pdfService.generateClaimDocumentPDF(data, claim);
      }
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${data.id}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/links — related claims (CL-DEMO2) ─────────────────
router.get(
  '/:id/links',
  requireAuth,
  requireRole(['admin', 'supervisor']), // supervisors: read-only oversight (daily alert drawer links)
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claimLinks = require('../services/claimLinkService');
      res.json({ links: await claimLinks.listLinks(req.params.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/ledger — immutable audit history (ADR-0003) ──────
router.get(
  '/:id/ledger',
  requireAuth,
  requireRole(['admin', 'supervisor']), // read-only oversight
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const auditLedger = require('../services/auditLedgerService');
      res.json({ entries: await auditLedger.listForClaim(req.params.id) });
    } catch (err) {
      logger.error({ msg: 'claims/ledger: read failed', claimId: req.params.id, requestId: req.id, err: err.message });
      res.status(500).json({ error: 'ledger_read_failed', requestId: req.id });
    }
  }
);

// ── GET /api/v1/claims/:id/decision-brief — plain-language what/why ──────────
router.get(
  '/:id/decision-brief',
  requireAuth,
  requireRole(['admin', 'supervisor']), // supervisors: read-only oversight (daily alert drawer links)
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });
      // RAW diary rows, not the mapped shape: the mapping prefers
      // fh_diary_id for its diaryId field, which is the system-of-record
      // mirror id — the drawer needs OUR diary id to drive the
      // aftermath endpoints.
      const { data: diaryRows } = await supabase
        .from('diaries').select('*').eq('claim_id', req.params.id);
      const { data: documents } = await supabase
        .from('claim_documents').select('*').eq('claim_id', req.params.id);
      const brief = decisionBriefService.buildBrief({ claim, diaries: diaryRows || [], documents: documents || [] });
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
  requireClaimScope('params.id'),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      const docId = claim.dwc1DocumentId;
      if (!docId) return res.status(404).json({ error: 'DWC-1 not yet generated for this claim' });

      const doc = await db.documents.findById(docId);
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
// ── POST /api/v1/claims/:id/dwc1/request-signature — DocuSign stub ────────────
// Logs claim_event and creates an actionable diary so adjuster follows up.
router.post(
  '/:id/dwc1/request-signature',
  requireAuth,
  requireRole(['employee', 'admin']),
  requireClaimScope('params.id'),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      const tenantId = claim.tenantId || claim.tenant_id;
      const nowIso = new Date().toISOString();

      const { error: evErr } = await supabase.from('claim_events').insert({
        claim_id:  claim.id,
        type:      'dwc1_signature_pending',
        timestamp: nowIso,
        tenant_id: tenantId,
        data:      {
          requestedBy: req.user.sub,
          note:        'DocuSign not yet integrated — manual follow-up by adjuster required',
        },
      });
      if (evErr) logger.error({ msg: 'dwc1/request-signature event insert failed', err: evErr.message });

      const diaryDue = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { error: diaryErr } = await supabase.from('diaries').insert({
        claim_id:    claim.id,
        diary_type:  'DWC1_SIGNATURE_FOLLOWUP',
        due_date:    diaryDue,
        status:      'open',
        priority:    'HIGH',
        assigned_to: claim.adjusterId || config.adjuster?.email || 'adjuster@claimlayer.com',
        notes:       `Injured worker requested DWC-1 signature. DocuSign envelope pending manual completion. (User: ${req.user.sub})`,
        fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        tenant_id:   tenantId,
      });
      if (diaryErr) logger.error({ msg: 'dwc1/request-signature diary insert failed', err: diaryErr.message });

      res.json({
        status:  'pending',
        message: 'Your adjuster will contact you to complete your signature.',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── PATCH /api/v1/claims/:id/intake-progress — update intake step flags ─────────
router.patch(
  '/:id/intake-progress',
  requireAuth,
  requireRole(['employee', 'admin']),
  requireClaimScope('params.id'),
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

      const defaultIntake = {
        voice_complete: false, media_complete: false, mpn_acknowledged: false,
        provider_selected: false, appointment_confirmed: false, dwc1_generated: false,
      };
      const currentIntake = claim.intakeProgress || defaultIntake;
      const updatedIntake = {
        ...currentIntake,
        [req.body.step]: req.body.value,
      };

      const nowIso = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from('claims')
        .update({
          intake_progress: updatedIntake,
          updated_at: nowIso,
        })
        .eq('id', req.params.id);

      if (updateErr) throw new Error(updateErr.message);

      const tenantId = claim.tenantId || claim.tenant_id;
      await supabase.from('claim_events').insert({
        claim_id:  claim.id,
        type:      'intake_progress_updated',
        timestamp: nowIso,
        tenant_id: tenantId,
        data:      {
          step:  req.body.step,
          value: req.body.value,
          updatedIntake,
        },
      });

      res.json({ intake_progress: updatedIntake });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/ledger/reserves — Double-Entry Reserve Ledger ─────
router.get(
  '/:id/ledger/reserves',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster']),
  requireClaimScope('params.id'),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const reserveLedger = require('../services/reserveLedgerService');
      const balances = await reserveLedger.getBalances(req.params.id);
      const transactions = await reserveLedger.getTransactions(req.params.id);
      res.json({
        claim_id: req.params.id,
        balances: balances.totals,
        categories: balances.categories,
        transactions,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/claims/:id/ledger/payments — Payment Ledger ──────────────────
router.get(
  '/:id/ledger/payments',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster']),
  requireClaimScope('params.id'),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const paymentLedger = require('../services/paymentLedgerService');
      const payments = await paymentLedger.getPayments(req.params.id);
      res.json({ claim_id: req.params.id, payments });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/claims/:id/ledger/payments — Issue Payment Directly ─────────
router.post(
  '/:id/ledger/payments',
  requireAuth,
  requireRole(['admin', 'supervisor', 'adjuster']),
  requireClaimScope('params.id'),
  [
    param('id').notEmpty(),
    body('amount').isFloat({ gt: 0 }).withMessage('amount must be greater than 0'),
    body('category').isIn(['indemnity', 'medical', 'expense']).withMessage('category must be indemnity, medical, or expense'),
    body('paymentType').notEmpty().withMessage('paymentType is required'),
    body('method').optional().isIn(['check', 'ach', 'digital_card']),
  ],
  validate,
  async (req, res) => {
    try {
      const claim = await claimService.getClaim(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      const paymentLedger = require('../services/paymentLedgerService');
      const row = await paymentLedger.issuePayment({
        tenantId: req.user.tenantId || claim.tenantId,
        claimId: req.params.id,
        payeeId: req.body.payeeId,
        category: req.body.category,
        paymentType: req.body.paymentType,
        amount: req.body.amount,
        method: req.body.method || 'check',
        checkNumber: req.body.checkNumber,
        memo: req.body.memo,
        periodStart: req.body.periodStart,
        periodEnd: req.body.periodEnd,
        createdBy: req.user.sub || req.user.email,
      });

      res.status(201).json({ status: 'issued', payment: row });
    } catch (err) {
      if (err.message.includes('DUPLICATE_PAYMENT_DETECTED')) {
        return res.status(409).json({ error: err.message, code: 'DUPLICATE_PAYMENT' });
      }
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
