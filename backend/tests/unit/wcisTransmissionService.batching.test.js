'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/wcisTransmissionService');

async function seedTxn(id, overrides = {}) {
  await supabase.from('wcis_transactions').insert({
    id, claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00',
    mtc_date: '2025-06-15', environment: 'test',
    payload: {}, payload_hash: 'h',
    adapter_used: 'stub', status: 'generated',
    ...overrides,
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('batchAndTransmit — empty queue', () => {
  test('returns zero counts when no pending transactions', async () => {
    const r = await svc.batchAndTransmit('test');
    expect(r).toEqual({ transmissions_created: 0, transactions_sent: 0 });
  });
  test('does not touch DB when empty', async () => {
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    expect(data).toHaveLength(0);
  });
});

describe('batchAndTransmit — single-family', () => {
  test('creates one transmission for all FROI in environment', async () => {
    await seedTxn('t1');
    await seedTxn('t2');
    await seedTxn('t3');
    const r = await svc.batchAndTransmit('test');
    expect(r.transmissions_created).toBe(1);
    expect(r.transactions_sent).toBe(3);
  });
  test('transaction_count matches number of transactions', async () => {
    await seedTxn('t1'); await seedTxn('t2');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    expect(data[0].transaction_count).toBe(2);
  });
  test('transactions linked to transmission via transmission_id', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    const { data: txns } = await supabase.from('wcis_transactions').select('*');
    const { data: tsms } = await supabase.from('wcis_transmissions').select('*');
    expect(txns[0].transmission_id).toBe(tsms[0].id);
  });
  test('transaction status transitions to stub_transmitted', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transactions').select('*').eq('id', 't1').single();
    expect(data.status).toBe('stub_transmitted');
  });
});

describe('batchAndTransmit — FROI vs SROI separation', () => {
  test('FROI and SROI create separate transmissions', async () => {
    await seedTxn('t1', { mtc_family: 'FROI' });
    await seedTxn('t2', { mtc_family: 'SROI', mtc_code: 'IP' });
    const r = await svc.batchAndTransmit('test');
    expect(r.transmissions_created).toBe(2);
    expect(r.transactions_sent).toBe(2);
  });
  test('transmissions have distinct mtc_family', async () => {
    await seedTxn('t1', { mtc_family: 'FROI' });
    await seedTxn('t2', { mtc_family: 'SROI', mtc_code: 'IP' });
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    const families = new Set(data.map(r => r.mtc_family));
    expect(families.has('FROI')).toBe(true);
    expect(families.has('SROI')).toBe(true);
  });
});

describe('batchAndTransmit — file_sequence', () => {
  test('first transmission has file_sequence = 1', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    expect(data[0].file_sequence).toBe(1);
  });
  test('subsequent transmissions increment file_sequence', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    await seedTxn('t2');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    const seqs = data.map(r => r.file_sequence).sort();
    expect(seqs).toEqual([1, 2]);
  });
});

describe('batchAndTransmit — environment isolation', () => {
  test('does not pick up other environment', async () => {
    await seedTxn('t1', { environment: 'test' });
    await seedTxn('t2', { environment: 'production' });
    const r = await svc.batchAndTransmit('test');
    expect(r.transactions_sent).toBe(1);
  });
});

describe('batchAndTransmit — adapter/status field', () => {
  test('adapter_used is stub when WCIS_ADAPTER=stub', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    expect(data[0].adapter_used).toBe('stub');
  });
  test('transmission status is stub_transmitted', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    expect(data[0].status).toBe('stub_transmitted');
  });
  test('vendor_reference populated on transmission', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    const { data } = await supabase.from('wcis_transmissions').select('*');
    expect(data[0].vendor_reference).toMatch(/^STUB-/);
  });
});

describe('pollAcksForEnvironment', () => {
  test('returns applied=0 when no matured transmissions', async () => {
    const r = await svc.pollAcksForEnvironment('test');
    expect(r.applied).toBe(0);
  });
  test('applies synthesized acks end-to-end', async () => {
    await seedTxn('t1');
    await svc.batchAndTransmit('test');
    // Accelerate transmission maturity
    const { data: tsms } = await supabase.from('wcis_transmissions').select('*');
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase.from('wcis_transmissions').update({ transmitted_at: past }).eq('id', tsms[0].id);
    await supabase.from('wcis_transactions').update({ transmitted_at: past }).eq('id', 't1');

    const r = await svc.pollAcksForEnvironment('test');
    expect(r.applied).toBe(1);
    const { data: updated } = await supabase.from('wcis_transactions').select('*').eq('id', 't1').single();
    expect(updated.status).toBe('accepted');
  });
});
