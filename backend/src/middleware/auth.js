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
// Payload should include: { claimId, employerId, adpEmployeeId }
function generateMagicToken(payload) {
  return jwt.sign(
    { ...payload, role: 'employee' },
    config.jwtSecret,
    { expiresIn: '72h' }
  );
}

// ── generateAdminToken ────────────────────────────────────────────────────────
// Utility for generating test tokens in dev/test environments.
function generateAdminToken(payload) {
  return jwt.sign(
    { ...payload, role: 'admin' },
    config.jwtSecret,
    { expiresIn: '8h' }
  );
}

// ── generateEmployerToken ─────────────────────────────────────────────────────
// Issues an 8-hour JWT for employer portal sessions.
function generateEmployerToken(payload) {
  return jwt.sign(
    { ...payload, role: 'employer' },
    config.jwtSecret,
    { expiresIn: '8h' }
  );
}

// ── requireMFA ────────────────────────────────────────────────────────────────
// Checks that the authenticated user has verified TOTP MFA (amr includes 'totp').
// When SUPABASE_URL is absent (dev/test), this is a no-op pass-through.
// In production (M4+), wire this to Supabase Auth MFA verification.
function requireMFA(req, res, next) {
  if (!process.env.SUPABASE_URL) {
    // Dev/test: MFA enforcement disabled — pass through
    return next();
  }
  const amr = req.user?.amr || [];
  if (!amr.includes('totp')) {
    return res.status(403).json({ error: 'MFA verification required' });
  }
  next();
}

module.exports = { requireAuth, requireRole, generateMagicToken, generateAdminToken, generateEmployerToken, requireMFA };
