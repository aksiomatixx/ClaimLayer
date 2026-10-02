'use strict';

/**
 * Claim-scope authorization (IDOR protection).
 *
 * Every employee-facing route that touches a claim-bound resource must
 * verify the resource belongs to the claim bound into the caller's
 * session token:
 *
 *   admin    — passes (full access).
 *   employee — req.user.claimId (set at magic-link validation) must
 *              equal the resource's claim id. Nothing else.
 *   employer — the claim's employer_id must match the token's employer.
 *
 * Denials are a uniform 403 { error: 'Access denied' } that never
 * reveals whether the resource exists or who owns it.
 */

const { supabase } = require('../services/supabase');
const config       = require('../config');

const DENIED = { error: 'Access denied' };

async function _claimMeta(claimId) {
  const { data } = await supabase
    .from('claims').select('employer_id, tenant_id').eq('id', claimId).single();
  if (data) return { employerId: data.employer_id, tenantId: data.tenant_id };
  const claimService = require('../services/claimService');
  const claim = await claimService.getClaim(claimId).catch(() => null);
  return claim ? { employerId: claim.employerId, tenantId: claim.tenantId } : {};
}

/**
 * May this authenticated user act on this claim? Unknown claims are
 * denied for non-admins so the 403 carries no existence signal.
 */
async function userMayAccessClaim(user, claimId) {
  if (!user || !claimId) return false;
  const meta = await _claimMeta(claimId);
  const claimTenant = meta.tenantId || (meta.employerId ? config.tenancy.defaultTenantId : null);

  // Tenant isolation: caller's tenant must match claim's tenant
  if (user.tenantId && claimTenant && user.tenantId !== claimTenant) {
    return false;
  }

  if (user.role === 'admin') return true;
  // Supervisors oversee the whole book — but read-only. Write routes
  // carry their own requireRole(['admin']) gates; the GET-only pass in
  // requireClaimScope below is what lets the daily-alert drawer links
  // open a claim under a supervisor session.
  if (user.role === 'employee') return user.claimId === claimId;
  if (user.role === 'employer') {
    const employerId = user.employerId || user.sub;
    return meta.employerId !== undefined && meta.employerId === employerId;
  }
  return false;
}

/**
 * Middleware factory.
 *
 * `resolve` locates the claim id on the request: either a dotted path
 * shorthand ('params.id', 'body.claim_id') or an async (req) => claimId
 * function for routes where the claim hangs off another resource
 * (appointment id, document id). Resolution runs only for non-admins,
 * so admin requests for missing resources still reach the route's own
 * 404 handling.
 *
 * On success the verified id is exposed as req.scopedClaimId.
 */
function requireClaimScope(resolve) {
  const resolver = typeof resolve === 'function'
    ? resolve
    : (req) => resolve.split('.').reduce((o, k) => (o == null ? undefined : o[k]), req);

  return async (req, res, next) => {
    let claimId;
    try {
      claimId = await resolver(req);
    } catch {
      return res.status(403).json(DENIED);
    }

    if (!claimId) {
      if (req.user?.role === 'admin' && !req.user?.tenantId) return next();
      return res.status(403).json(DENIED);
    }

    // Cross-tenant enforcement for tenant-scoped callers
    if (req.user?.tenantId) {
      const meta = await _claimMeta(claimId);
      const claimTenant = meta.tenantId || (meta.employerId ? config.tenancy.defaultTenantId : null);
      if (claimTenant && claimTenant !== req.user.tenantId) {
        return res.status(403).json(DENIED);
      }
    }

    if (req.user?.role === 'admin') {
      req.scopedClaimId = claimId;
      return next();
    }
    // Read-only oversight: supervisors may READ any claim-scoped
    // resource (their daily alert spans every adjuster's book), never
    // write through this gate.
    if (req.user?.role === 'supervisor' && req.method === 'GET') {
      req.scopedClaimId = claimId;
      return next();
    }
    if (!(await userMayAccessClaim(req.user, claimId))) {
      return res.status(403).json(DENIED);
    }
    req.scopedClaimId = claimId;
    next();
  };
}

module.exports = { requireClaimScope, userMayAccessClaim };
