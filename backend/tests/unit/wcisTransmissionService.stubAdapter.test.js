'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const stubAdapter = require('../../src/services/wcis_adapters/stubAdapter');
const logger = require('../../src/logger');

beforeEach(() => { supabase._resetStore(); });

describe('stubAdapter.transmit', () => {
  test('returns stub vendor_reference with STUB- prefix', async () => {
    const r = await stubAdapter.transmit({ environment: 'test', mtc_family: 'FROI', transactions: [] });
    expect(r.vendor_reference).toMatch(/^STUB-/);
  });
  test('returns ISO submitted_at', async () => {
    const r = await stubAdapter.transmit({ transactions: [] });
    expect(new Date(r.submitted_at).toString()).not.toBe('Invalid Date');
  });
  test('returns estimated_ack_by ~30s later than submitted_at', async () => {
    const r = await stubAdapter.transmit({ transactions: [] });
    const diff = new Date(r.estimated_ack_by) - new Date(r.submitted_at);
    expect(diff).toBe(30 * 1000);
  });
  test('vendor_reference unique per call', async () => {
    const a = await stubAdapter.transmit({ transactions: [] });
    const b = await stubAdapter.transmit({ transactions: [] });
    expect(a.vendor_reference).not.toBe(b.vendor_reference);
  });
  test('emits WARN log with unignorable message', async () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await stubAdapter.transmit({ environment: 'test', mtc_family: 'FROI', transactions: [{}] });
    const calls = spy.mock.calls;
    const warned = calls.find(c => c[0] && c[0].msg && c[0].msg.includes('NOT SENT TO WCIS'));
    expect(warned).toBeTruthy();
    expect(warned[0].msg).toMatch(/production must swap adapter/i);
    spy.mockRestore();
  });
  test('warning log includes vendor_reference and count', async () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = await stubAdapter.transmit({ environment: 'pilot', mtc_family: 'SROI',
      transactions: [{}, {}, {}] });
    const warned = spy.mock.calls.find(c => c[0] && c[0].msg && c[0].msg.includes('NOT SENT TO WCIS'));
    expect(warned[0].vendor_reference).toBe(r.vendor_reference);
    expect(warned[0].transactions_count).toBe(3);
    spy.mockRestore();
  });
});

describe('stubAdapter.healthCheck', () => {
  test('returns ok=true', async () => {
    const r = await stubAdapter.healthCheck();
    expect(r.ok).toBe(true);
  });
  test('detail references stubAdapter', async () => {
    const r = await stubAdapter.healthCheck();
    expect(r.detail).toMatch(/stubAdapter/);
  });
});

describe('stubAdapter._nextStubJcn', () => {
  test('returns STUB-YYYY-NNNNNN format', async () => {
    const jcn = await stubAdapter._nextStubJcn();
    expect(jcn).toMatch(/^STUB-\d{4}-\d{6}$/);
  });
  test('returns different JCN on subsequent calls', async () => {
    const a = await stubAdapter._nextStubJcn();
    const b = await stubAdapter._nextStubJcn();
    expect(a).not.toBe(b);
  });
});

describe('stubAdapter.pollAcks', () => {
  test('returns empty when no transmissions', async () => {
    const r = await stubAdapter.pollAcks('test');
    expect(r).toEqual([]);
  });

  test('skips transmissions that have not matured (< 30s old)', async () => {
    await supabase.from('wcis_transmissions').insert({
      id: 'tx1', environment: 'test', mtc_family: 'FROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted',
      transmitted_at: new Date().toISOString(), // just now
    });
    const r = await stubAdapter.pollAcks('test');
    expect(r.length).toBe(0);
  });

  test('synthesizes 824 for matured transmission', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase.from('wcis_transmissions').insert({
      id: 'tx2', environment: 'test', mtc_family: 'FROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted', transmitted_at: old,
    });
    await supabase.from('wcis_transactions').insert({
      id: 'txn1', claim_id: 'c1', transmission_id: 'tx2',
      mtc_family: 'FROI', mtc_code: '00', mtc_date: '2025-06-15',
      environment: 'test', payload: {}, payload_hash: 'h',
      adapter_used: 'stub', status: 'stub_transmitted',
    });
    const r = await stubAdapter.pollAcks('test');
    expect(r).toHaveLength(1);
    expect(r[0].ack_type).toBe('824');
    expect(r[0].per_transaction).toHaveLength(1);
    expect(r[0].per_transaction[0].result).toBe('accepted');
  });

  test('generates JCN for FROI 00 accept', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase.from('wcis_transmissions').insert({
      id: 'tx3', environment: 'test', mtc_family: 'FROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted', transmitted_at: old,
    });
    await supabase.from('wcis_transactions').insert({
      id: 'txn2', claim_id: 'c1', transmission_id: 'tx3',
      mtc_family: 'FROI', mtc_code: '00', mtc_date: '2025-06-15',
      environment: 'test', payload: {}, payload_hash: 'h',
      adapter_used: 'stub', status: 'stub_transmitted',
    });
    const r = await stubAdapter.pollAcks('test');
    expect(r[0].per_transaction[0].jcn).toMatch(/^STUB-\d{4}-\d{6}$/);
  });

  test('does NOT generate JCN for SROI', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase.from('wcis_transmissions').insert({
      id: 'tx4', environment: 'test', mtc_family: 'SROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted', transmitted_at: old,
    });
    await supabase.from('wcis_transactions').insert({
      id: 'txn3', claim_id: 'c1', transmission_id: 'tx4',
      mtc_family: 'SROI', mtc_code: 'IP', mtc_date: '2025-09-01',
      environment: 'test', payload: {}, payload_hash: 'h',
      adapter_used: 'stub', status: 'stub_transmitted',
    });
    const r = await stubAdapter.pollAcks('test');
    expect(r[0].per_transaction[0].jcn).toBeUndefined();
  });

  test('returns unique JCN across multiple FROI 00 accepts', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    for (let i = 1; i <= 3; i++) {
      const tid = `tx5_${i}`;
      await supabase.from('wcis_transmissions').insert({
        id: tid, environment: 'test', mtc_family: 'FROI',
        file_sequence: i, transaction_count: 1, adapter_used: 'stub',
        status: 'stub_transmitted', transmitted_at: old,
      });
      await supabase.from('wcis_transactions').insert({
        id: `txn5_${i}`, claim_id: `c${i}`, transmission_id: tid,
        mtc_family: 'FROI', mtc_code: '00', mtc_date: '2025-06-15',
        environment: 'test', payload: {}, payload_hash: 'h',
        adapter_used: 'stub', status: 'stub_transmitted',
      });
    }
    const r = await stubAdapter.pollAcks('test');
    const jcns = r.flatMap(b => b.per_transaction.map(p => p.jcn));
    expect(new Set(jcns).size).toBe(3);
  });

  test('skips transmissions already ack_824_received', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase.from('wcis_transmissions').insert({
      id: 'tx6', environment: 'test', mtc_family: 'FROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted', transmitted_at: old,
      ack_824_received_at: new Date().toISOString(),
    });
    const r = await stubAdapter.pollAcks('test');
    expect(r.length).toBe(0);
  });

  test('only returns matched environment', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    await supabase.from('wcis_transmissions').insert({
      id: 'txA', environment: 'test', mtc_family: 'FROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted', transmitted_at: old,
    });
    await supabase.from('wcis_transmissions').insert({
      id: 'txB', environment: 'production', mtc_family: 'FROI',
      file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
      status: 'stub_transmitted', transmitted_at: old,
    });
    const r = await stubAdapter.pollAcks('production');
    expect(r.length).toBeLessThanOrEqual(1);
    if (r.length === 1) expect(r[0].transmission_id).toBe('txB');
  });
});

describe('sftpAdapter + vendorAdapter (scaffolds)', () => {
  const sftp = require('../../src/services/wcis_adapters/sftpAdapter');
  const vendor = require('../../src/services/wcis_adapters/vendorAdapter');
  test('sftp.transmit throws AdapterNotImplemented', async () => {
    await expect(sftp.transmit({})).rejects.toThrow(/not implemented/);
  });
  test('sftp.healthCheck throws AdapterNotImplemented', async () => {
    await expect(sftp.healthCheck()).rejects.toThrow(/not implemented/);
  });
  test('vendor.transmit throws AdapterNotImplemented', async () => {
    await expect(vendor.transmit({})).rejects.toThrow(/not implemented/);
  });
  test('vendor.pollAcks throws AdapterNotImplemented', async () => {
    await expect(vendor.pollAcks('test')).rejects.toThrow(/not implemented/);
  });
  test('sftp.name = sftp', () => {
    expect(sftp.name).toBe('sftp');
  });
  test('vendor.name = vendor', () => {
    expect(vendor.name).toBe('vendor');
  });
});
