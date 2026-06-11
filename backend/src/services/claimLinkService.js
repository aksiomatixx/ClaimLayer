'use strict';

/**
 * Claim Linking (CL-DEMO2).
 *
 * Symmetric links between claims — initially 'prior_claim_same_worker'.
 * One row per pair (ids normalized lexicographically before insert so a
 * reversed duplicate hits the same UNIQUE constraint); listLinks
 * surfaces the link from either side with the LINKED claim's facts
 * (number, DOI, body part, status) ready for the drawer.
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const logger       = require('../logger');

const RELATION_TYPES = ['prior_claim_same_worker'];

function _id() {
  return `clk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function _claimOrThrow(claimId) {
  const { data, error } = await supabase
    .from('claims').select('id').eq('id', claimId).single();
  if (error || !data) throw new Error(`Claim not found: ${claimId}`);
  return data;
}

async function createLink(claimIdA, claimIdB, { relation_type = 'prior_claim_same_worker', note } = {}, actorEmail) {
  if (!claimIdA || !claimIdB || claimIdA === claimIdB) {
    throw new Error('A link requires two distinct claims');
  }
  if (!RELATION_TYPES.includes(relation_type)) {
    throw new Error(`relation_type must be one of: ${RELATION_TYPES.join(', ')}`);
  }
  await _claimOrThrow(claimIdA);
  await _claimOrThrow(claimIdB);

  // Normalize the pair so (A,B) and (B,A) are the same row.
  const [a, b] = [claimIdA, claimIdB].sort();

  const { data: existing, error: exErr } = await supabase
    .from('claim_links').select('*').eq('claim_id_a', a).eq('claim_id_b', b);
  if (exErr) throw new Error(`claimLink: lookup failed — ${exErr.message}`);
  if (existing && existing.length > 0) return existing[0]; // idempotent

  const row = {
    id: _id(),
    claim_id_a: a,
    claim_id_b: b,
    relation_type,
    note: note || null,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('claim_links').insert(row).select().single();
  if (error) throw new Error(`claimLink: insert failed — ${error.message}`);

  for (const cid of [a, b]) {
    const { error: evErr } = await supabase.from('claim_events').insert({
      claim_id: cid, type: 'claim_linked', timestamp: row.created_at,
      data: { link_id: row.id, linked_claim_id: cid === a ? b : a, relation_type, note: note || null, actor: actorEmail || null },
    });
    if (evErr) logger.error({ msg: 'claimLink: event insert failed', err: evErr.message });
  }
  return data;
}

/**
 * All links for a claim, from either side, each carrying the linked
 * claim's facts for display.
 */
async function listLinks(claimId) {
  const [{ data: asA, error: eA }, { data: asB, error: eB }] = await Promise.all([
    supabase.from('claim_links').select('*').eq('claim_id_a', claimId),
    supabase.from('claim_links').select('*').eq('claim_id_b', claimId),
  ]);
  if (eA || eB) throw new Error(`claimLink: list failed — ${(eA || eB).message}`);

  const rows = [...(asA || []), ...(asB || [])];
  const links = [];
  for (const row of rows) {
    const otherId = row.claim_id_a === claimId ? row.claim_id_b : row.claim_id_a;
    const { data: other } = await supabase
      .from('claims')
      .select('id, claim_number, date_of_injury, body_part, status')
      .eq('id', otherId).single();
    links.push({
      link_id: row.id,
      relation_type: row.relation_type,
      note: row.note,
      created_at: row.created_at,
      linked_claim: other ? {
        id: other.id,
        claim_number: other.claim_number,
        date_of_injury: other.date_of_injury,
        body_part: other.body_part,
        status: other.status,
      } : { id: otherId, claim_number: null, date_of_injury: null, body_part: null, status: null },
    });
  }
  return links.sort((x, y) =>
    String(x.linked_claim.date_of_injury || '').localeCompare(String(y.linked_claim.date_of_injury || '')));
}

module.exports = { createLink, listLinks, RELATION_TYPES };
