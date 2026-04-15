'use strict';

/**
 * employer.js — Employer portal API routes (M4).
 *
 * POST /api/v1/employer/froi                        — submit FROI, create claim, send magic link
 * GET  /api/v1/employer/employee-preview/:adpId     — ADP name preview for on-blur validation
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const adp                  = require('../services/adp');
const claimService         = require('../services/claimService');
const notificationService  = require('../services/notificationService');
const db                   = require('../services/db');
const logger               = require('../logger');
const { requireAuth, requireRole, generateMagicToken } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const domainParts = domain.split('.');
  return `${local[0]}***@***.${domainParts[domainParts.length - 1]}`;
}

// ── POST /api/v1/employer/froi ────────────────────────────────────────────────
// Employer submits FROI → creates claim → generates + sends employee magic link.
// Returns 201 with claim summary and magic_link_url.
router.post(
  '/froi',
  requireAuth,
  requireRole(['admin', 'employer']),
  [
    body('adpEmployeeId')
      .notEmpty().withMessage('adpEmployeeId is required'),
    body('dateOfInjury')
      .isISO8601().withMessage('dateOfInjury must be a valid date (YYYY-MM-DD)')
      .custom((value) => {
        const doi  = new Date(value);
        const now  = new Date();
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        if (doi > now) throw new Error('dateOfInjury cannot be in the future');
        if (doi < oneYearAgo) throw new Error('dateOfInjury cannot be more than 1 year ago');
        return true;
      }),
    body('bodyPart')
      .optional().isLength({ max: 100 }).withMessage('bodyPart must be 100 characters or fewer'),
    body('injuryType')
      .optional().isLength({ max: 100 }).withMessage('injuryType must be 100 characters or fewer'),
  ],
  validate,
  async (req, res) => {
    const { adpEmployeeId, dateOfInjury, bodyPart, injuryType } = req.body;
    const employerId = req.user.employerId || req.user.sub;
    const employerName = req.user.employerName || 'Unknown Employer';

    // 1. Pull employee from ADP ─────────────────────────────────────────────────
    let employee;
    try {
      employee = await adp.getEmployeeWithFinancials(adpEmployeeId);
    } catch (err) {
      logger.warn({ msg: 'employer/froi: ADP pull failed', adpEmployeeId, err: err.message });
      return res.status(422).json({ error: 'employee_not_found', message: `Employee ${adpEmployeeId} not found in ADP` });
    }

    // 2. Create claim ────────────────────────────────────────────────────────────
    const claim = await claimService.createClaim(
      { adpEmployeeId, dateOfInjury, bodyPart, injuryType, employerName },
      employerId
    );

    // 3. Generate magic link token ───────────────────────────────────────────────
    const jti = `${claim.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const token = generateMagicToken({ claimId: claim.id, employerId, adpEmployeeId, jti });
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    // 4. Register token for single-use enforcement ──────────────────────────────
    db.magicLinkTokens.create({
      jti,
      claim_id:        claim.id,
      adp_employee_id: adpEmployeeId,
      employer_id:     employerId,
      expires_at:      expiresAt,
    });

    // 5. Push magic_link_sent event ─────────────────────────────────────────────
    claim.events.push({
      type:      'magic_link_sent',
      timestamp: new Date().toISOString(),
      data:      { jti, expiresAt, channel: employee.email ? 'email' : 'none' },
    });

    // 6. Send email notification ────────────────────────────────────────────────
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const magicLinkUrl = `${baseUrl}/claim?t=${token}`;

    let warning = null;
    let warningMessage = null;

    if (!employee.email) {
      logger.warn({
        msg:          'employer/froi: no employee email — skipping SendGrid',
        adpEmployeeId,
        claimNumber:  claim.claimNumber,
      });
      warning = 'no_employee_email';
      warningMessage = 'This employee has no email address on file in ADP. Copy the link below and deliver it directly (text, in-person, or company intranet).';
    } else {
      try {
        await notificationService.sendMagicLinkEmail({
          toEmail:      employee.email,
          toName:       `${employee.firstName} ${employee.lastName}`,
          employerName,
          claimNumber:  claim.claimNumber,
          magicLinkUrl,
          expiresAt,
        });
      } catch (err) {
        // Non-fatal — claim is created, link still works
        logger.error({ msg: 'employer/froi: SendGrid failed (non-fatal)', err: err.message, claimNumber: claim.claimNumber });
        warning = 'email_send_failed';
        warningMessage = 'Claim created but email delivery failed. Copy and send the link manually.';
      }
    }

    logger.info({ msg: 'employer/froi: complete', claimId: claim.id, claimNumber: claim.claimNumber, employerId });

    res.status(201).json({
      claim_id:      claim.id,
      claim_number:  claim.claimNumber,
      employee_name: `${employee.firstName} ${employee.lastName}`,
      email_masked:  maskEmail(employee.email),
      magic_link_url: magicLinkUrl,
      expires_at:    expiresAt,
      adp_data: {
        job_title: employee.jobTitle,
        aww:       employee.aww,
        td_rate:   employee.tdRate,
      },
      warning,
      warning_message: warningMessage,
    });
  }
);

// ── GET /api/v1/employer/employee-preview/:adpEmployeeId ──────────────────────
// ADP name preview for on-blur validation in the FROI form.
// Always returns 200 — { found: false } if employee not in ADP.
router.get(
  '/employee-preview/:adpEmployeeId',
  requireAuth,
  requireRole(['admin', 'employer']),
  [param('adpEmployeeId').notEmpty()],
  validate,
  async (req, res) => {
    const { adpEmployeeId } = req.params;
    try {
      const employee = await adp.getEmployeeWithFinancials(adpEmployeeId);
      res.json({
        found:        true,
        first_name:   employee.firstName,
        last_name:    employee.lastName,
        job_title:    employee.jobTitle,
        email_masked: maskEmail(employee.email),
      });
    } catch {
      res.json({ found: false });
    }
  }
);

module.exports = router;
