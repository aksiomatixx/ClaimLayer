'use strict';

/**
 * auth.js — Authentication routes.
 *
 * POST /api/v1/auth/magic-link/validate      — validates single-use token, returns intake state
 * POST /api/v1/auth/magic-link/generate      — generates a new magic link (admin only)
 * POST /api/v1/auth/employer/login           — email/password login for employer portal
 * GET  /api/v1/auth/dev-session              — dev-only admin auto-login
 * GET  /api/v1/auth/dev-employer-session     — dev-only employer auto-login
 * POST /api/v1/auth/mfa/enroll              — MFA enroll stub (M5)
 * POST /api/v1/auth/mfa/verify              — MFA verify stub (M5)
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db      = require('../services/db');
const adp     = require('../services/adp');
const logger  = require('../logger');
const config  = require('../config');
const { requireAuth, requireRole, generateMagicToken, generateEmployerToken } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/auth/magic-link/validate ─────────────────────────────────────
// Employee opens their magic link → frontend POSTs the JWT here for validation.
// Returns: { claim, employee, intake_progress } or 401/410.
router.post(
  '/magic-link/validate',
  [body('token').notEmpty().withMessage('token is required')],
  validate,
  async (req, res) => {
    const { token } = req.body;

    // 1. Decode and verify JWT
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      return res.status(401).json({ error: 'invalid_token', message: 'This link is invalid or has expired.' });
    }

    if (!payload.claimId) {
      return res.status(401).json({ error: 'invalid_token', message: 'Token is missing required claim context.' });
    }

    // 2. Check single-use (jti required for production; optional in dev)
    if (payload.jti) {
      const tokenRecord = db.magicLinkTokens.findByJti(payload.jti);
      if (!tokenRecord) {
        return res.status(401).json({ error: 'invalid_token', message: 'This link is no longer valid.' });
      }
      if (tokenRecord.used_at) {
        return res.status(410).json({ error: 'link_already_used', message: 'This link has already been used. Please contact your employer for a new link.' });
      }
      // Mark used atomically
      db.magicLinkTokens.markUsed(payload.jti);
    }

    // 3. Pull employee from ADP (or use cached record)
    let employee = db.employees.findByAdpId(payload.adpEmployeeId);
    if (!employee && payload.adpEmployeeId) {
      try {
        const adpData = await adp.getEmployeeWithFinancials(payload.adpEmployeeId);
        employee = db.employees.upsert(payload.adpEmployeeId, adpData);
      } catch (err) {
        logger.warn({ msg: 'magic-link: ADP pull failed (non-fatal)', err: err.message });
        // Use payload data as fallback
        employee = { adpEmployeeId: payload.adpEmployeeId };
      }
    }

    // 4. Fetch claim
    const claimService = require('../services/claimService');
    const claim = await claimService.getClaim(payload.claimId);
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found for this link.' });
    }

    // 5. Initialize intake progress if first visit
    if (!claim.intakeProgress) {
      claim.intakeProgress = {
        voice_complete:       false,
        media_complete:       false,
        mpn_acknowledged:     false,
        provider_selected:    false,
        appointment_confirmed: false,
        dwc1_generated:       false,
      };
    }

    // 6. Issue a session JWT for the employee (valid for 24h from link validation)
    const sessionToken = jwt.sign(
      { sub: payload.adpEmployeeId, role: 'employee', claimId: payload.claimId, employerId: claim.employerId },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    logger.info({ msg: 'magic-link: validated', claimId: payload.claimId, adpEmployeeId: payload.adpEmployeeId });

    res.json({
      session_token:   sessionToken,
      claim,
      employee,
      intake_progress: claim.intakeProgress,
    });
  }
);

// ── POST /api/v1/auth/magic-link/generate — admin generates link for employee ─
router.post(
  '/magic-link/generate',
  requireAuth,
  requireRole(['admin']),
  [
    body('claim_id').notEmpty().withMessage('claim_id is required'),
    body('adp_employee_id').notEmpty().withMessage('adp_employee_id is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const { claim_id, adp_employee_id } = req.body;
      const jti = `${claim_id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const token = generateMagicToken({ claimId: claim_id, adpEmployeeId: adp_employee_id, jti });

      // Register token for single-use tracking
      db.magicLinkTokens.create({
        jti,
        claim_id,
        adp_employee_id,
        expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      });

      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const link    = `${baseUrl}/claim?t=${token}`;

      logger.info({ msg: 'magic-link: generated', claimId: claim_id, adpEmployeeId: adp_employee_id });
      res.json({ token, link, expires_in: '72h' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/v1/auth/employer/login ─────────────────────────────────────────
// Email + password login for employer portal.
// Production replacement: swap mock lookup for supabase.auth.signInWithPassword()
router.post(
  '/employer/login',
  [
    body('email').isEmail().withMessage('email must be a valid email address'),
    body('password').notEmpty().withMessage('password is required'),
  ],
  validate,
  (req, res) => {
    const { email, password } = req.body;

    const user = db.users.findByEmail(email);
    if (!user || user.role !== 'employer') {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Mock password check — replace with Supabase Auth in M5
    if (!db.users.checkPassword(email, password)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = generateEmployerToken({
      sub:          user.id,
      email:        user.email,
      employerId:   user.employer_id,
      employerName: user.employer_name,
    });

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   8 * 60 * 60 * 1000, // 8 hours
    });

    logger.info({ msg: 'employer/login: success', email, employerId: user.employer_id });
    res.json({ ok: true, employer_id: user.employer_id, employer_name: user.employer_name, email: user.email });
  }
);

// ── GET /api/v1/auth/dev-session — dev-only admin auto-login ──────────────────
// Issues an admin cookie for local development and demo environments.
// BLOCKED in production and when NODE_ENV is unset.
router.get('/dev-session', (req, res) => {
  if (!['development', 'test'].includes(process.env.NODE_ENV)) {
    return res.status(403).json({ error: 'Not available in production' });
  }

  const { generateAdminToken } = require('../middleware/auth');
  const token = generateAdminToken({
    sub:   'dev-admin',
    email: 'admin@homecaretpa.com',
    name:  'Dev Admin',
  });

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
  });

  res.json({ ok: true, role: 'admin', expiresIn: '8h' });
});

// ── GET /api/v1/auth/dev-employer-session — dev-only employer auto-login ──────
// Issues an employer cookie for local development and demo environments.
// BLOCKED in production and when NODE_ENV is unset.
router.get('/dev-employer-session', (req, res) => {
  if (!['development', 'test'].includes(process.env.NODE_ENV)) {
    return res.status(403).json({ error: 'Not available in production' });
  }

  const token = generateEmployerToken({
    sub:          'dev-employer',
    email:        'hr@brightcarehh.com',
    employerId:   'employer-brightcare',
    employerName: 'BrightCare Home Health',
  });

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
  });

  res.json({ ok: true, role: 'employer', employerId: 'employer-brightcare', employerName: 'BrightCare Home Health' });
});

// ── POST /api/v1/auth/mfa/enroll — Supabase MFA enroll stub (M5) ─────────────
router.post('/mfa/enroll', requireAuth, (req, res) => {
  // Placeholder — wire to Supabase Auth MFA API in M5
  res.status(501).json({ error: 'MFA enrollment not yet implemented — coming in M5' });
});

// ── POST /api/v1/auth/mfa/verify — Supabase MFA verify stub (M5) ─────────────
router.post('/mfa/verify', requireAuth, (req, res) => {
  // Placeholder — wire to Supabase Auth MFA API in M5
  res.status(501).json({ error: 'MFA verification not yet implemented — coming in M5' });
});

module.exports = router;
