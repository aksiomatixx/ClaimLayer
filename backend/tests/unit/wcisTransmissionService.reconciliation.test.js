'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/wcisTransmissionService');

async function seedTransmission(id, overrides = {}) {
  await supabase.from('wcis_transmissions').insert({
    id, environment: 'test', mtc_family: 'FROI',
    file_sequence: 1, transaction_count: 1, adapter_used: 'stub',
    status: 'stub_transmitted',
    transmitted_at: new Date(Date.now() - 60 * 1000).toISOString(),
    ...overrides,
  });
}
async function seedTransaction(id, transmissionId, overrides = {}) {
  await supabase.from('wcis_transactions').insert({
    id, claim_id: overrides.claim_id || 'c1', transmission_id: transmissionId,
    mtc_family: 'FROI', mtc_code: '00', mtc_date: '2025-06-15',
    environment: 'test', payload: {}, payload_hash: 'h',
    adapter_used: 'stub', status: 'stub_transmitted',
    ...overrides,
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('_applyAckBatch — 824 accept', () => {
  test('stamps transaction status=accepted', async () => {
    await seedTransmission('tx1');
    await seedTransaction('txn1', 'tx1');
    await svc._applyAckBatch({
      transmission_id: 'tx1', ack_type: '824',
      received_at: new Date().toISOString(), ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txn1', result: 'accepted' }],
    });
    const { data } = await supabase.from('wcis_transactions').select('*').eq('id', 'txn1').single();
    expect(data.status).toBe('accepted');
    expect(data.ack_type).toBe('824');
  });

  test('stamps transmission ack_824_received_at + status', async () => {
    await seedTransmission('tx2');
    await seedTransaction('txn2', 'tx2');
    await svc._applyAckBatch({
      transmission_id: 'tx2', ack_type: '824',
      received_at: '2025-06-20T10:00:00Z', ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txn2', result: 'accepted' }],
    });
    const { data: tx } = await supabase.from('wcis_transmissions').select('*').eq('id', 'tx2').single();
    expect(tx.ack_824_received_at).toBe('2025-06-20T10:00:00Z');
    expect(tx.status).toBe('ack_824_received');
  });

  test('FROI 00 accept writes JCN to wcis_claim_state', async () => {
    await supabase.from('claims').insert({ id: 'c1', claim_number: 'HHW-2026-001' });
    await seedTransmission('tx3');
    await seedTransaction('txn3', 'tx3', { claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00' });
    await svc._applyAckBatch({
      transmission_id: 'tx3', ack_type: '824',
      received_at: new Date().toISOString(), ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txn3', result: 'accepted', jcn: 'STUB-2026-000042' }],
    });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c1').single();
    expect(data.jcn).toBe('STUB-2026-000042');
    expect(data.first_froi_accepted_at).toBeTruthy();
  });

  test('SROI FN accept stamps closed_at on claim state', async () => {
    await supabase.from('claims').insert({ id: 'c2', claim_number: 'X' });
    await supabase.from('wcis_claim_state').insert({ claim_id: 'c2', claim_admin_claim_number: 'X' });
    await seedTransmission('tx4', { mtc_family: 'SROI' });
    await seedTransaction('txn4', 'tx4', { claim_id: 'c2', mtc_family: 'SROI', mtc_code: 'FN' });
    await svc._applyAckBatch({
      transmission_id: 'tx4', ack_type: '824',
      received_at: '2026-01-15T10:00:00Z', ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txn4', result: 'accepted' }],
    });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c2').single();
    expect(data.closed_at).toBe('2026-01-15T10:00:00Z');
  });

  test('SROI 04 accept stamps denied_at on claim state', async () => {
    await supabase.from('claims').insert({ id: 'c3', claim_number: 'X' });
    await supabase.from('wcis_claim_state').insert({ claim_id: 'c3', claim_admin_claim_number: 'X' });
    await seedTransmission('tx5', { mtc_family: 'SROI' });
    await seedTransaction('txn5', 'tx5', { claim_id: 'c3', mtc_family: 'SROI', mtc_code: '04' });
    await svc._applyAckBatch({
      transmission_id: 'tx5', ack_type: '824',
      received_at: '2026-01-16T10:00:00Z', ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txn5', result: 'accepted' }],
    });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c3').single();
    expect(data.denied_at).toBe('2026-01-16T10:00:00Z');
  });

  test('SROI accept stamps last_sroi_mtc on claim state', async () => {
    await supabase.from('claims').insert({ id: 'c4', claim_number: 'X' });
    await supabase.from('wcis_claim_state').insert({ claim_id: 'c4', claim_admin_claim_number: 'X' });
    await seedTransmission('tx6', { mtc_family: 'SROI' });
    await seedTransaction('txn6', 'tx6', { claim_id: 'c4', mtc_family: 'SROI', mtc_code: 'IP' });
    await svc._applyAckBatch({
      transmission_id: 'tx6', ack_type: '824',
      received_at: new Date().toISOString(), ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txn6', result: 'accepted' }],
    });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c4').single();
    expect(data.last_sroi_mtc).toBe('IP');
  });
});

describe('_applyAckBatch — TE / TR', () => {
  test('TE creates CRITICAL diary', async () => {
    await seedTransmission('txA');
    await seedTransaction('txnA', 'txA');
    await svc._applyAckBatch({
      transmission_id: 'txA', ack_type: '824',
      received_at: new Date().toISOString(), ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txnA', result: 'accepted_with_error',
        errors: [{ dn: 'DN42_employee_ssn', code: 'SSN_BLOCKLISTED' }] }],
    });
    const { data } = await supabase.from('wcis_transactions').select('*').eq('id', 'txnA').single();
    expect(data.status).toBe('accepted_with_error');
    expect(data.ack_error_codes).toBeTruthy();

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'c1');
    expect(diaries.some(d => d.diary_type === 'WCIS_TE_ACK' && d.priority === 'CRITICAL')).toBe(true);
  });
  test('TR creates CRITICAL diary', async () => {
    await seedTransmission('txB');
    await seedTransaction('txnB', 'txB');
    await svc._applyAckBatch({
      transmission_id: 'txB', ack_type: '824',
      received_at: new Date().toISOString(), ack_raw: 'RAW',
      per_transaction: [{ transaction_id: 'txnB', result: 'rejected',
        errors: [{ dn: 'DN15_claim_admin_claim_number', code: 'INVALID_DELIMITER_CHAR' }] }],
    });
    const { data } = await supabase.from('wcis_transactions').select('*').eq('id', 'txnB').single();
    expect(data.status).toBe('rejected');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'c1');
    expect(diaries.some(d => d.diary_type === 'WCIS_TR_ACK' && d.priority === 'CRITICAL')).toBe(true);
  });
});

describe('_updateOpenBenefitCodes', () => {
  beforeEach(async () => {
    await supabase.from('claims').insert({ id: 'c9', claim_number: 'X' });
    await supabase.from('wcis_claim_state').insert({ claim_id: 'c9', claim_admin_claim_number: 'X',
      open_benefit_codes: [] });
  });

  test('IP 050 adds 050 to open', async () => {
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'IP',
      payload: { benefit_lines: [{ DN85_benefit_type_code: '050' }] } });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).toContain('050');
  });
  test('CB 050→030 removes 050, adds 030', async () => {
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['050'] }).eq('claim_id', 'c9');
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'CB',
      payload: { benefit_lines: [{ DN85_benefit_type_code: '030' }],
        payload_context: { from_benefit_code: '050', to_benefit_code: '030' } } });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).toContain('030');
    expect(data.open_benefit_codes).not.toContain('050');
  });
  test('S1 suspension removes the benefit', async () => {
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['050'] }).eq('claim_id', 'c9');
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'S1',
      payload: { benefit_lines: [{ DN85_benefit_type_code: '050' }] } });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).not.toContain('050');
  });
  test('FN clears all open benefits', async () => {
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['030', '050'] }).eq('claim_id', 'c9');
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'FN', payload: {} });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).toEqual([]);
  });
  test('AP adds benefit', async () => {
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'AP',
      payload: { benefit_lines: [{ DN85_benefit_type_code: '050' }] } });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).toContain('050');
  });
  test('RB adds benefit', async () => {
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'RB',
      payload: { benefit_lines: [{ DN85_benefit_type_code: '030' }] } });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).toContain('030');
  });
  test('P1 partial suspension removes benefit', async () => {
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['070'] }).eq('claim_id', 'c9');
    await svc._updateOpenBenefitCodes({ claim_id: 'c9', mtc_code: 'P1',
      payload: { benefit_lines: [{ DN85_benefit_type_code: '070' }] } });
    const { data } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c9').single();
    expect(data.open_benefit_codes).not.toContain('070');
  });
});

describe('getActiveAdapter / setAdapter', () => {
  test('getActiveAdapter returns configured adapter', async () => {
    const a = await svc.getActiveAdapter();
    expect(a.name).toBe(process.env.WCIS_ADAPTER || 'stub');
  });
  test('setAdapter swaps active adapter', async () => {
    const orig = process.env.WCIS_ADAPTER || 'stub';
    await svc.setAdapter('sftp');
    expect((await svc.getActiveAdapter()).name).toBe('sftp');
    await svc.setAdapter(orig);
  });
  test('setAdapter throws on unknown', async () => {
    await expect(svc.setAdapter('xyz')).rejects.toThrow();
  });
});

describe('997 ack', () => {
  test('997 marks transmission ack_997_received', async () => {
    await seedTransmission('tx7');
    await seedTransaction('txn7', 'tx7');
    await svc._applyAckBatch({
      transmission_id: 'tx7', ack_type: '997',
      received_at: '2025-06-20T09:00:00Z', ack_raw: '997',
      per_transaction: [],
    });
    const { data } = await supabase.from('wcis_transmissions').select('*').eq('id', 'tx7').single();
    expect(data.ack_997_received_at).toBe('2025-06-20T09:00:00Z');
    expect(data.status).toBe('ack_997_received');
  });
});
