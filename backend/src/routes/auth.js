'use strict';

/**
 * auth.js — Authentication routes.
 *
 * POST /api/v1/auth/magic-link/validate      — validates single-use token, returns intake state
 * POST /api/v1/auth/magic-link/generate      — generates a new magic link (admin only)
 * POST /api/v1/auth/employer/login           — email/password login for employer portal (M5: Supabase Auth)
 * GET  /api/v1/auth/dev-session              — dev-only admin auto-login
 * GET  /api/v1/auth/dev-employer-session     — dev-only employer auto-login
 * POST /api/v1/auth/mfa/enroll              — MFA enroll stub (M5)
 * POST /api/v1/auth/mfa/verify              — MFA verify stub (M5)
 */

const express  = require('express');
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db             = require('../services/db');
const { supabaseAuth } = require('../services/supabase');
const adp            = require('../services/adp');
const logger         = require('../logger');
const config         = require('../config');
const {
  requireAuth,
  requireRole,
  generateMagicToken,
  generateEmployerToken,
} = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── POST /api/v1/auth/magic-link/validate ─────────────────────────────────────
router.post(
  '/magic-link/validate',
  [body('token').notEmpty().withMessage('token is required')],
  validate,
  async (req, res) => {
    const { token } = req.body;

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      return res.status(401).json({ error: 'invalid_token', message: 'This link is invalid or has expired.' });
    }

    if (!payload.claimId) {
      return res.status(401).json({ error: 'invalid_token', message: 'Token is missing required claim context.' });
    }

    // Check single-use (jti required for production; optional in dev)
    if (payload.jti) {
      const tokenRecord = await db.magicLinkTokens.findByJti(payload.jti);
      if (!tokenRecord) {
        return res.status(401).json({ error: 'invalid_token', message: 'This link is no longer valid.' });
      }
      if (tokenRecord.used_at) {
        return res.status(410).json({ error: 'link_already_used', message: 'This link has already been used. Please contact your employer for a new link.' });
      }
      await db.magicLinkTokens.markUsed(payload.jti);
    }

    // Pull employee from ADP (or use cached record)
    let employee = await db.employees.findByAdpId(payload.adpEmployeeId);
    if (!employee && payload.adpEmployeeId) {
      try {
        const adpData = await adp.getEmployeeWithFinancials(payload.adpEmployeeId);
        employee = await db.employees.upsert(payload.adpEmployeeId, adpData);
      } catch (err) {
        logger.warn({ msg: 'magic-link: ADP pull failed (non-fatal)', err: err.message });
        employee = { adpEmployeeId: payload.adpEmployeeId };
      }
    }

    const claimService = require('../services/claimService');
    const claim = await claimService.getClaim(payload.claimId);
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found for this link.' });
    }

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

// ── POST /api/v1/auth/magic-link/generate ─────────────────────────────────────
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

      await db.magicLinkTokens.create({
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
// M5: Uses Supabase Auth signInWithPassword instead of mock password check.
router.post(
  '/employer/login',
  [
    body('email').isEmail().withMessage('email must be a valid email address'),
    body('password').notEmpty().withMessage('password is required'),
  ],
  validate,
  async (req, res) => {
    const { email, password } = req.body;

    // Authenticate via Supabase Auth
    const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (authError || !authData?.user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const supaUser = authData.user;
    const meta     = supaUser.user_metadata || {};

    // Verify role is employer
    if (meta.role && meta.role !== 'employer') {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = generateEmployerToken({
      sub:          supaUser.id,
      email:        supaUser.email,
      employerId:   meta.employer_id,
      employerName: meta.employer_name,
    });

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   8 * 60 * 60 * 1000, // 8 hours
    });

    logger.info({ msg: 'employer/login: success', email, employerId: meta.employer_id });
    res.json({ ok: true, employer_id: meta.employer_id, employer_name: meta.employer_name, email: supaUser.email });
  }
);

// ── GET /api/v1/auth/dev-session ──────────────────────────────────────────────
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

  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
  res.json({ ok: true, role: 'admin', expiresIn: '8h' });
});

// ── GET /api/v1/auth/dev-employer-session ─────────────────────────────────────
router.get('/dev-employer-session', (req, res) => {
  if (!['development', 'test'].includes(process.env.NODE_ENV)) {
    return res.status(403).json({ error: 'Not available in production' });
  }

  const token = generateEmployerToken({
    sub:          'dev-employer',
    email:        'hr@brightcarehh.com',
    employerId:   'employer-brightcare-001',
    employerName: 'BrightCare Home Health',
  });

  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
  res.json({ ok: true, role: 'employer', employerId: 'employer-brightcare-001', employerName: 'BrightCare Home Health' });
});

// ── POST /api/v1/auth/mfa/enroll ──────────────────────────────────────────────
router.post('/mfa/enroll', requireAuth, (req, res) => {
  res.status(501).json({ error: 'MFA enrollment not yet implemented — coming in M5' });
});

// ── POST /api/v1/auth/mfa/verify ──────────────────────────────────────────────
router.post('/mfa/verify', requireAuth, (req, res) => {
  res.status(501).json({ error: 'MFA verification not yet implemented — coming in M5' });
});

module.exports = router;
