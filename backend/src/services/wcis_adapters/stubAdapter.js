'use strict';

/**
 * stubAdapter.js — M22A synthetic WCIS adapter.
 *
 * Ships with M22A. Does NOT transmit to real WCIS. Synthesizes
 * vendor references and 824 acknowledgements so the rest of the
 * pipeline (transmission → ack → reconciliation) can be exercised
 * end-to-end against an isolated environment.
 *
 * WARNING: every call to transmit() emits a loud warning log.
 * Production deployments must swap this adapter (set WCIS_ADAPTER
 * to 'sftp' or 'vendor') before any real claim data is sent.
 */

const { randomUUID } = require('crypto');
const { supabase } = require('../supabase');
const logger       = require('../../logger');

const NAME = 'stub';

function _isoNow() { return new Date().toISOString(); }

function _plus30s(iso) {
  return new Date(new Date(iso).getTime() + 30 * 1000).toISOString();
}

// ─── transmit ────────────────────────────────────────────────────
//
// Synthesize a vendor_reference and return the contract shape.
// Does NOT write to the database — caller (wcisTransmissionService)
// persists.
//
async function transmit(batch) {
  const count = (batch && batch.transactions && batch.transactions.length) || 0;
  const vendor_reference = `STUB-${randomUUID()}`;
  const submitted_at     = _isoNow();
  const estimated_ack_by = _plus30s(submitted_at);

  // Mandatory unignorable warning. Leveled at WARN so it surfaces
  // in prod logs but does not halt operation. Message references
  // adapter swap explicitly.
  logger.warn({
    msg: 'stubAdapter.transmit: NOT SENT TO WCIS — production must swap adapter. ' +
         'Set WCIS_ADAPTER=sftp|vendor before real claim data.',
    vendor_reference,
    transactions_count: count,
    environment: batch && batch.environment,
    mtc_family: batch && batch.mtc_family,
  });

  return { vendor_reference, submitted_at, estimated_ack_by };
}

// ─── _nextStubJcn ────────────────────────────────────────────────
//
// Sequence-backed stub JCN. If the DB sequence is unreachable
// (unit-test environment), fall back to an in-memory counter.
//
let _memSeq = 0;
async function _nextStubJcn() {
  try {
    const { data, error } = await supabase.rpc('nextval', {
      relname: 'wcis_stub_jcn_seq',
    });
    if (!error && data) {
      const year = new Date().getFullYear();
      return `STUB-${year}-${String(data).padStart(6, '0')}`;
    }
  } catch (_e) { /* fall through */ }
  _memSeq += 1;
  const year = new Date().getFullYear();
  return `STUB-${year}-${String(_memSeq).padStart(6, '0')}`;
}

// ─── pollAcks ────────────────────────────────────────────────────
//
// For every transmission in the given environment whose
// transmitted_at is past estimated_ack_by and which has not yet
// received an 824, synthesize an 824 accept. For FROI 00
// transactions in the batch, generate a JCN.
//
async function pollAcks(environment) {
  const now = new Date();
  const thirtySecAgo = new Date(now.getTime() - 30 * 1000).toISOString();

  const { data: transmissions, error } = await supabase
    .from('wcis_transmissions')
    .select('*')
    .eq('environment', environment)
    .eq('status', 'stub_transmitted');

  if (error) {
    logger.error({ msg: 'stubAdapter.pollAcks: query failed', err: error.message });
    return [];
  }

  const acks = [];
  for (const tx of transmissions || []) {
    if (!tx.transmitted_at || tx.transmitted_at > thirtySecAgo) continue;
    if (tx.ack_824_received_at) continue;

    const { data: txnRows } = await supabase
      .from('wcis_transactions')
      .select('id,mtc_family,mtc_code')
      .eq('transmission_id', tx.id);

    const per_transaction = [];
    for (const row of txnRows || []) {
      const entry = { transaction_id: row.id, result: 'accepted' };
      if (row.mtc_family === 'FROI' && row.mtc_code === '00') {
        entry.jcn = await _nextStubJcn();
      }
      per_transaction.push(entry);
    }

    acks.push({
      transmission_id: tx.id,
      ack_type:        '824',
      received_at:     now.toISOString(),
      ack_raw:         `STUB-824|${tx.id}|ALL_ACCEPTED`,
      per_transaction,
    });
  }
  return acks;
}

// ─── healthCheck ─────────────────────────────────────────────────
async function healthCheck() {
  return { ok: true, detail: 'stubAdapter — synthetic, always healthy' };
}

module.exports = {
  name: NAME,
  transmit,
  pollAcks,
  healthCheck,
  _nextStubJcn,
};
