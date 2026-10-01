'use strict';

/**
 * Principals — the single canonical shape for "who is acting".
 *
 *   { type: 'human' | 'agent' | 'system', id, role, tenantId, mfa }
 *
 * Every consequential path (audit ledger, authority evaluation, approval
 * decisions) takes a principal rather than ad-hoc email strings, so the
 * self-approval check, the ledger actor and the authority lookup all compare
 * the same identifier. Humans come only from a verified session (req.user);
 * agents and system workers are named explicitly in code.
 */

const config = require('../config');

function humanPrincipal(user) {
  if (!user) throw new Error('humanPrincipal: an authenticated user is required');
  const id = user.email || user.sub;
  if (!id) throw new Error('humanPrincipal: the session carries no identity');
  return Object.freeze({
    type:     'human',
    id,
    role:     user.role || null,
    tenantId: user.tenantId || config.tenancy.defaultTenantId,
    mfa:      user.mfa === true,
  });
}

function agentPrincipal(agentName, tenantId) {
  if (!agentName) throw new Error('agentPrincipal: agent name is required');
  return Object.freeze({
    type:     'agent',
    id:       `agent:${agentName}`,
    role:     'agent',
    tenantId: tenantId || config.tenancy.defaultTenantId,
    mfa:      false,
  });
}

function systemPrincipal(workerName, tenantId) {
  if (!workerName) throw new Error('systemPrincipal: worker name is required');
  return Object.freeze({
    type:     'system',
    id:       `system:${workerName}`,
    role:     'system',
    tenantId: tenantId || config.tenancy.defaultTenantId,
    mfa:      false,
  });
}

/** The audit_ledger actor columns for a principal. */
function ledgerActor(principal) {
  return {
    actor_type: principal.type,
    actor_id:   principal.id,
    actor_role: principal.role,
  };
}

module.exports = { humanPrincipal, agentPrincipal, systemPrincipal, ledgerActor };
