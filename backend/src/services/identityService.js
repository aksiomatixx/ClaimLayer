'use strict';

/**
 * identityService — server-authoritative identity (finding S-1, ADR-0002).
 *
 * Supabase Auth proves WHO a person is (password, MFA). It must never decide
 * WHAT they may do: `user_metadata` is writable by the user themselves
 * (sign-up `options.data`, `auth.updateUser`), so a role, tenant or employer
 * read from it is self-asserted. Every authorization attribute therefore
 * comes from the provisioned `public.users` row, read with the service-role
 * client, keyed by the authenticated user's id.
 *
 *   no users row      → not_provisioned (an account an operator never set up)
 *   users.active=false → inactive        (deprovisioned staff keep their
 *                                         Supabase password; login must stop)
 */

const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');

/**
 * @param {{ id: string, email?: string }} authUser — the Supabase Auth user
 * @returns {Promise<{ ok: true, identity: object } | { ok: false, reason: string }>}
 */
async function resolveIdentity(authUser) {
  if (!authUser?.id) return { ok: false, reason: 'not_provisioned' };

  const { data: row, error } = await supabase
    .from('users').select('*').eq('id', authUser.id).single();

  if (error || !row) {
    logger.warn({ msg: 'identity: authenticated user has no provisioned users row', authUserId: authUser.id });
    return { ok: false, reason: 'not_provisioned' };
  }
  if (row.active === false) {
    logger.warn({ msg: 'identity: login refused for inactive user', authUserId: authUser.id });
    return { ok: false, reason: 'inactive' };
  }

  return {
    ok: true,
    identity: {
      id:         row.id,
      email:      authUser.email || row.email,
      role:       row.role,
      tenantId:   row.tenant_id || config.tenancy.defaultTenantId,
      employerId: row.employer_id || null,
    },
  };
}

module.exports = { resolveIdentity };
