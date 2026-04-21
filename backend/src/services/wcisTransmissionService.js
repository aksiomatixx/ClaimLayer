'use strict';

/**
 * wcisTransmissionService.js — M22A WCIS batching, transmission,
 * and ack reconciliation orchestrator.
 *
 * Pipeline:
 *   1. batchAndTransmit(environment): group 'generated' wcis_transactions
 *      rows by (environment, mtc_family), insert a wcis_transmissions
 *      row, call adapter.transmit, mark transactions as
 *      'transmitted' / 'stub_transmitted'.
 *
 *   2. pollAcksForEnvironment(environment): ask the adapter for new
 *      ack batches. For each:
 *        - Update wcis_transmissions with ack timestamps.
 *        - Update each wcis_transactions row with per-transaction
 *          result (accepted / accepted_with_error / rejected).
 *        - On FROI 00 accept: write JCN to wcis_claim_state,
 *          stamp first_froi_accepted_at.
 *        - On TE / TR: create CRITICAL diary on the claim for
 *          adjuster follow-up (TODO(M17B): route to licensed adjuster).
 *
 * Adapter selection at init from WCIS_ADAPTER env var. Default 'stub'.
 * Throws at require-time if set to unknown value.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');
const wcisTriggerService = require('./wcisTriggerService');

const ADAPTERS = {
  stub:   require('./wcis_adapters/stubAdapter'),
  sftp:   require('./wcis_adapters/sftpAdapter'),
  vendor: require('./wcis_adapters/vendorAdapter'),
};

let _activeAdapterName = process.env.WCIS_ADAPTER || 'stub';
if (!ADAPTERS[_activeAdapterName]) {
  throw new Error(
    `wcisTransmissionService: WCIS_ADAPTER='${_activeAdapterName}' is unknown. ` +
    `Valid values: ${Object.keys(ADAPTERS).join(', ')}`,
  );
}

async function getActiveAdapter() {
  return ADAPTERS[_activeAdapterName];
}

async function setAdapter(name) {
  if (!ADAPTERS[name]) {
    throw new Error(`wcisTransmissionService.setAdapter: unknown '${name}'`);
  }
  const prev = _activeAdapterName;
  _activeAdapterName = name;
  logger.info({
    msg: 'wcisTransmissionService: adapter swapped', from: prev, to: name,
  });
  return ADAPTERS[name];
}

// ─── batchAndTransmit ────────────────────────────────────────────
//
// Groups 'generated' transactions by (environment, mtc_family) for
// the given environment, calls the adapter, persists the
// transmission row. Returns { transmissions_created, transactions_sent }.
//
async function batchAndTransmit(environment) {
  const adapter = await getActiveAdapter();

  const { data: pending, error } = await supabase
    .from('wcis_transactions')
    .select('*')
    .eq('environment', environment)
    .eq('status', 'generated');
  if (error) {
    logger.error({ msg: 'wcisTransmissionService.batchAndTransmit: query failed', err: error.message });
    return { transmissions_created: 0, transactions_sent: 0 };
  }
  if (!pending || pending.length === 0) {
    return { transmissions_created: 0, transactions_sent: 0 };
  }

  // Group: FROI and SROI cannot mix in a single batch (guide Section L).
  const groups = {};
  for (const t of pending) {
    const key = t.mtc_family;
    (groups[key] = groups[key] || []).push(t);
  }

  let transmissions_created = 0;
  let transactions_sent = 0;

  for (const [family, txns] of Object.entries(groups)) {
    // File sequence: monotonic per environment.
    const { data: last } = await supabase
      .from('wcis_transmissions')
      .select('file_sequence')
      .eq('environment', environment)
      .order('file_sequence', { ascending: false })
      .limit(1);
    const nextSeq = (last && last.length && last[0].file_sequence
      ? last[0].file_sequence + 1 : 1);

    const adapterName = _activeAdapterName;
    const adapterStatus = adapterName === 'stub' ? 'stub_transmitted' : 'transmitted';

    const fileName = `WCIS_${family}_${environment}_${String(nextSeq).padStart(6, '0')}.dat`;

    const { data: tx, error: txErr } = await supabase
      .from('wcis_transmissions')
      .insert({
        environment,
        mtc_family:        family,
        file_name:         fileName,
        file_sequence:     nextSeq,
        transaction_count: txns.length,
        adapter_used:      adapterName,
        status:            'building',
      })
      .select()
      .single();

    if (txErr || !tx) {
      logger.error({
        msg: 'wcisTransmissionService.batchAndTransmit: transmission insert failed',
        err: txErr && txErr.message,
      });
      continue;
    }

    // Call the adapter
    let result;
    try {
      result = await adapter.transmit({
        environment,
        mtc_family: family,
        file_name:  fileName,
        transactions: txns,
      });
    } catch (err) {
      logger.error({
        msg: 'wcisTransmissionService.batchAndTransmit: adapter.transmit failed',
        err: err.message, transmission_id: tx.id,
      });
      await supabase.from('wcis_transmissions')
        .update({ status: 'failed', error_message: err.message })
        .eq('id', tx.id);
      continue;
    }

    // Persist adapter response on the transmission row.
    await supabase.from('wcis_transmissions')
      .update({
        status:           adapterStatus,
        vendor_reference: result.vendor_reference,
        transmitted_at:   result.submitted_at,
        updated_at:       new Date().toISOString(),
      })
      .eq('id', tx.id);

    // Link each transaction to the transmission + mark transmitted.
    for (const t of txns) {
      await supabase.from('wcis_transactions')
        .update({
          transmission_id:  tx.id,
          status:           adapterStatus,
          vendor_reference: result.vendor_reference,
          transmitted_at:   result.submitted_at,
          adapter_used:     adapterName,
          updated_at:       new Date().toISOString(),
        })
        .eq('id', t.id);
    }

    transmissions_created += 1;
    transactions_sent += txns.length;
  }

  logger.info({
    msg: 'wcisTransmissionService.batchAndTransmit: complete',
    environment, transmissions_created, transactions_sent,
  });

  return { transmissions_created, transactions_sent };
}

// ─── pollAcksForEnvironment ──────────────────────────────────────
//
// Asks the adapter for acks, applies them to wcis_transactions /
// wcis_transmissions / wcis_claim_state, creates diaries on TE/TR.
//
async function pollAcksForEnvironment(environment) {
  const adapter = await getActiveAdapter();
  const acks = await adapter.pollAcks(environment);
  if (!acks || acks.length === 0) return { applied: 0 };

  let applied = 0;
  for (const batch of acks) {
    await _applyAckBatch(batch);
    applied += 1;
  }
  return { applied };
}

async function _applyAckBatch(batch) {
  const nowIso = new Date().toISOString();
  // Transmission-level fields
  const tsmUpdate = { updated_at: nowIso };
  if (batch.ack_type === '997' || batch.ack_type === 'AK1') {
    tsmUpdate.ack_997_received_at = batch.received_at;
    tsmUpdate.status = 'ack_997_received';
  } else if (batch.ack_type === '824') {
    tsmUpdate.ack_824_received_at = batch.received_at;
    tsmUpdate.status = 'ack_824_received';
    tsmUpdate.ack_summary = {
      ack_type: '824',
      total: batch.per_transaction.length,
      accepted: batch.per_transaction.filter((p) => p.result === 'accepted').length,
      te:       batch.per_transaction.filter((p) => p.result === 'accepted_with_error').length,
      tr:       batch.per_transaction.filter((p) => p.result === 'rejected').length,
    };
  }
  await supabase.from('wcis_transmissions')
    .update(tsmUpdate).eq('id', batch.transmission_id);

  // Per-transaction updates
  for (const entry of batch.per_transaction || []) {
    const txnUpdate = {
      ack_type:        batch.ack_type,
      ack_received_at: batch.received_at,
      ack_raw:         batch.ack_raw,
      updated_at:      nowIso,
    };
    if (entry.result === 'accepted')             txnUpdate.status = 'accepted';
    if (entry.result === 'accepted_with_error')  txnUpdate.status = 'accepted_with_error';
    if (entry.result === 'rejected')             txnUpdate.status = 'rejected';
    if (entry.errors)                            txnUpdate.ack_error_codes = entry.errors;
    await supabase.from('wcis_transactions')
      .update(txnUpdate).eq('id', entry.transaction_id);

    // Read the transaction for post-ack processing
    const { data: txn } = await supabase
      .from('wcis_transactions')
      .select('*')
      .eq('id', entry.transaction_id)
      .single();
    if (!txn) continue;

    if (entry.result === 'accepted') {
      await _onTransactionAccepted(txn, entry);
    } else if (entry.result === 'accepted_with_error') {
      await _createCriticalDiary(
        txn, 'WCIS_TE_ACK',
        `TE ack on ${txn.mtc_family} ${txn.mtc_code}. Correction required within ` +
        `60 calendar days (guide Section L).`,
      );
    } else if (entry.result === 'rejected') {
      await _createCriticalDiary(
        txn, 'WCIS_TR_ACK',
        `TR ack on ${txn.mtc_family} ${txn.mtc_code}. Adjuster review required.`,
      );
    }
  }
}

async function _onTransactionAccepted(txn, entry) {
  // FROI 00 accept: write JCN to wcis_claim_state, stamp first_froi_accepted_at.
  if (txn.mtc_family === 'FROI' && txn.mtc_code === '00') {
    const jcn = entry.jcn || null;
    // Upsert wcis_claim_state.
    const { data: existing } = await supabase
      .from('wcis_claim_state')
      .select('claim_id')
      .eq('claim_id', txn.claim_id)
      .single();
    const patch = {
      jcn,
      first_froi_accepted_at: txn.ack_received_at || new Date().toISOString(),
      first_froi_transaction_id: txn.id,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      await supabase.from('wcis_claim_state').update(patch).eq('claim_id', txn.claim_id);
    } else {
      const { data: claim } = await supabase
        .from('claims').select('claim_number').eq('id', txn.claim_id).single();
      await supabase.from('wcis_claim_state').insert({
        claim_id: txn.claim_id,
        claim_admin_claim_number: (claim && claim.claim_number) || txn.claim_id,
        ...patch,
      });
    }
  }

  // FROI 04 / SROI 04 accept: stamp denied_at.
  if (txn.mtc_code === '04') {
    await supabase.from('wcis_claim_state')
      .update({ denied_at: txn.ack_received_at, updated_at: new Date().toISOString() })
      .eq('claim_id', txn.claim_id);
  }

  // SROI FN accept: stamp closed_at.
  if (txn.mtc_family === 'SROI' && txn.mtc_code === 'FN') {
    await supabase.from('wcis_claim_state')
      .update({ closed_at: txn.ack_received_at, updated_at: new Date().toISOString() })
      .eq('claim_id', txn.claim_id);
  }

  // Last-SROI tracking: stamp mtc + time for SROI family.
  if (txn.mtc_family === 'SROI') {
    await supabase.from('wcis_claim_state')
      .update({
        last_sroi_mtc:          txn.mtc_code,
        last_sroi_submitted_at: txn.transmitted_at,
        updated_at:             new Date().toISOString(),
      })
      .eq('claim_id', txn.claim_id);
  }

  // Update open_benefit_codes based on MTC + payload.
  await _updateOpenBenefitCodes(txn);
}

async function _updateOpenBenefitCodes(txn) {
  const { data: state } = await supabase
    .from('wcis_claim_state').select('open_benefit_codes')
    .eq('claim_id', txn.claim_id).single();
  const open = new Set((state && state.open_benefit_codes) || []);

  const payload = txn.payload || {};
  const lines = payload.benefit_lines || [];
  const mtc = txn.mtc_code;

  // Add to open on IP, CB (to_benefit_code), RB
  if (mtc === 'IP' || mtc === 'AP' || mtc === 'RB') {
    for (const l of lines) {
      if (l.DN85_benefit_type_code) open.add(l.DN85_benefit_type_code);
    }
  }
  if (mtc === 'CB') {
    const ctx = payload.payload_context || {};
    if (ctx.from_benefit_code) open.delete(ctx.from_benefit_code);
    if (ctx.to_benefit_code)   open.add(ctx.to_benefit_code);
  }
  // Remove on suspension / FN
  if (['S1','S2','S3','S7','P1','P2','P3','P7'].includes(mtc)) {
    for (const l of lines) {
      if (l.DN85_benefit_type_code) open.delete(l.DN85_benefit_type_code);
    }
  }
  if (mtc === 'FN') open.clear();

  await supabase.from('wcis_claim_state')
    .update({ open_benefit_codes: Array.from(open), updated_at: new Date().toISOString() })
    .eq('claim_id', txn.claim_id);
}

async function _createCriticalDiary(txn, diaryType, notes) {
  // TODO(M17B): reassign to licensed adjuster instead of
  // system@homecaretpa.com. See existing pattern in
  // pdService/cnrService/disbursementService.
  const row = {
    claim_id:    txn.claim_id,
    diary_type:  diaryType,
    due_date:    new Date().toISOString().slice(0, 10),
    assigned_to: 'system@homecaretpa.com',
    priority:    'CRITICAL',
    notes,
    status:      'open',
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  new Date().toISOString(),
  };
  await supabase.from('diaries').insert(row);
}

module.exports = {
  batchAndTransmit,
  pollAcksForEnvironment,
  getActiveAdapter,
  setAdapter,
  // Exported for tests
  _applyAckBatch,
  _onTransactionAccepted,
  _updateOpenBenefitCodes,
  _createCriticalDiary,
  _ADAPTERS: ADAPTERS,
  // For tests that want to suppress the service altogether
  _unusedTriggerDep: wcisTriggerService,
};
