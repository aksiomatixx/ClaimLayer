'use strict';

/**
 * Supabase client factory — M5 Supabase Swap.
 *
 * Two clients are exported:
 *   supabase      — service-role key, bypasses RLS for all server-side ops.
 *                   Used by claimService, db, and every internal data path.
 *
 *   supabaseAuth  — anon key, used only for Supabase Auth operations
 *                   (signInWithPassword, signOut, MFA).  The anon key is safe
 *                   to use for auth because Supabase validates the user's
 *                   JWT before granting access.
 *
 * verifyConnection() — call once at startup to confirm the DB is reachable.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const supabase = createClient(
  config.supabase.url    || 'http://localhost:54321',
  config.supabase.serviceRoleKey || 'no-service-key',
  {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
  }
);

const supabaseAuth = createClient(
  config.supabase.url    || 'http://localhost:54321',
  config.supabase.anonKey || 'no-anon-key',
  {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
  }
);

/**
 * Verify the Supabase connection is reachable.
 * Throws if the DB cannot be reached so the server refuses to start dirty.
 */
async function verifyConnection() {
  const { error } = await supabase.from('claims').select('count').limit(1);
  if (error) {
    throw new Error(`Supabase connection failed: ${error.message}`);
  }
  return true;
}

module.exports = { supabase, supabaseAuth, verifyConnection };
