'use strict';

const jwt    = require('jsonwebtoken');
const config = require('../config');

// ── requireAuth ───────────────────────────────────────────────────────────────
// Validates the JWT from either an httpOnly cookie (employer/admin) or a
// Bearer token in the Authorization header (employee magic-link flow).
function requireAuth(req, res, next) {
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── requireRole ───────────────────────────────────────────────────────────────
// Middleware factory. Call with an array of permitted roles.
// e.g.  requireRole(['admin'])  or  requireRole(['admin', 'employer'])
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Role '${req.user.role}' is not permitted to perform this action`,
      });
    }
    next();
  };
}

// ── generateMagicToken ────────────────────────────────────────────────────────
// Issues a 72-hour single-use JWT for the employee intake flow.
// Payload should include: { claimId, employerId, adpEmployeeId, jti }
// purpose: 'magic_link' — the validate endpoint accepts ONLY this
// purpose, so a session/admin token can never be replayed into it.
function generateMagicToken(payload) {
  return jwt.sign(
    { ...payload, role: 'employee', purpose: 'magic_link' },
    config.jwtSecret,
    { expiresIn: '72h' }
  );
}

// Staff roles that authenticate through Supabase Auth and carry a tenant.
const STAFF_ROLES = ['admin', 'adjuster', 'supervisor'];

// Every staff/employer session carries a tenantId so downstream code (and,
// later, RLS) can scope by tenant. `payload` wins over the default, so a
// real provisioned tenant overrides the single-tenant fallback.
function _sign(payload, role) {
  return jwt.sign(
    { tenantId: config.tenancy.defaultTenantId, ...payload, role },
    config.jwtSecret,
    { expiresIn: '8h' }
  );
}

// ── generateAdminToken ────────────────────────────────────────────────────────
// Utility for generating test tokens in dev/test environments.
function generateAdminToken(payload) {
  return _sign(payload, 'admin');
}

// ── generateEmployerToken ─────────────────────────────────────────────────────
// Issues an 8-hour JWT for employer portal sessions.
function generateEmployerToken(payload) {
  return _sign(payload, 'employer');
}

// ── generateSupervisorToken ───────────────────────────────────────────────────
// Issues an 8-hour JWT for supervisor oversight sessions (CL-SUP1).
function generateSupervisorToken(payload) {
  return _sign(payload, 'supervisor');
}

// ── generateStaffToken ────────────────────────────────────────────────────────
// Issues an 8-hour staff session JWT for a Supabase-authenticated adjuster/
// admin/supervisor. `role` is validated; `mfa` records whether the session was
// elevated through MFA (read by requireMFA).
function generateStaffToken({ role, ...payload }) {
  if (!STAFF_ROLES.includes(role)) {
    throw new Error(`generateStaffToken: '${role}' is not a staff role`);
  }
  return _sign(payload, role);
}

// ── requireMFA ────────────────────────────────────────────────────────────────
// Requires that the session was elevated through MFA. The staff login flow sets
// `mfa: true` only after a Supabase AAL2 (MFA-verified) token is presented.
// When SUPABASE_URL is absent (dev/test/demo), this is a no-op pass-through.
function requireMFA(req, res, next) {
  if (!process.env.SUPABASE_URL) {
    // Dev/test/demo: MFA enforcement disabled — pass through
    return next();
  }
  if (req.user?.mfa === true) {
    return next();
  }
  return res.status(403).json({ error: 'MFA verification required' });
}

module.exports = {
  requireAuth, requireRole, requireMFA,
  generateMagicToken, generateAdminToken, generateEmployerToken,
  generateSupervisorToken, generateStaffToken, STAFF_ROLES,
};
