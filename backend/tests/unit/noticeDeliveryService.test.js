'use strict';

/**
 * Unit tests — Notice Delivery Orchestration.
 *
 * Channel resolution (explicit → provider config → audience default),
 * the functional portal adapter, loud vendor stubs (fax/electronic),
 * retry semantics up to MAX_ATTEMPTS, and the translation block.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/noticeDeliveryService');
const noticeTemplates = require('../../src/services/noticeTemplateService');

const CLAIM = 'claim_delivery_test';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-D-1', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1',
    employee: { firstName: 'Test', lastName: 'Worker' },
  });
});

async function workerNotice() {
  const { notices } = await noticeTemplates.generateNotice('claim_accepted', CLAIM, {});
  return notices[0];
}

describe('channel resolution', () => {
  it('worker default is mail + portal', async () => {
    expect(await svc.resolveChannels({ audience: 'worker', recipient: {} }))
      .toEqual(['mail', 'portal']);
  });

  it('attorney default is mail', async () => {
    expect(await svc.resolveChannels({ audience: 'attorney', recipient: {} }))
      .toEqual(['mail']);
  });

  it('provider uses configured delivery_method, falling back to fax', async () => {
    await supabase.from('providers').insert({ id: 'prov-1', name: 'Dr. D', delivery_method: 'electronic' });
    expect(await svc.resolveChannels({ audience: 'provider', recipient: { provider_id: 'prov-1' } }))
      .toEqual(['electronic']);
    expect(await svc.resolveChannels({ audience: 'provider', recipient: { name: 'Dr. Unknown' } }))
      .toEqual(['fax']);
  });

  it('explicit method always wins', async () => {
    expect(await svc.resolveChannels({ audience: 'worker', recipient: {} }, 'portal'))
      .toEqual(['portal']);
  });
});

describe('delivery', () => {
  it('worker notice delivers via mail stub + portal and records the event', async () => {
    const n = await workerNotice();
    const updated = await svc.deliverNotice(n.id, {});
    expect(updated.status).toBe('delivered');
    expect(updated.delivered_at).toBeTruthy();
    expect(updated.delivery_attempts).toBe(1);

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'notice_delivered')).toBe(true);
  });

  it('vendor-stub channels fail loudly and mark the row failed with the error recorded', async () => {
    const n = await workerNotice();
    const updated = await svc.deliverNotice(n.id, { method: 'fax' });
    expect(updated.status).toBe('failed');
    expect(updated.last_error).toContain('FAX_ADAPTER_NOT_CONFIGURED');
    expect(updated.delivery_attempts).toBe(1);
  });

  it('already-delivered notices are idempotent', async () => {
    const n = await workerNotice();
    await svc.deliverNotice(n.id, {});
    const again = await svc.deliverNotice(n.id, {});
    expect(again.status).toBe('delivered');
    expect(again.delivery_attempts).toBe(1); // unchanged
  });

  it('blocked translation rows can never be delivered', async () => {
    const { notices } = await noticeTemplates.generateNotice('claim_accepted', CLAIM, {}, { includeSpanish: true });
    const es = notices.find(x => x.language === 'es');
    await expect(svc.deliverNotice(es.id, {})).rejects.toThrow('blocked pending');
  });
});

describe('queue + retry pass', () => {
  it('deliverPending delivers queued rows and retries failed ones up to MAX_ATTEMPTS', async () => {
    const a = await workerNotice();
    await svc.queueNotice(a.id);

    const b = await workerNotice();
    // Force b into a failing channel by setting its method to fax.
    await supabase.from('benefit_notices').update({ method: 'fax', status: 'queued' }).eq('id', b.id);

    const pass1 = await svc.deliverPending();
    expect(pass1.find(o => o.id === a.id).status).toBe('delivered');
    expect(pass1.find(o => o.id === b.id).status).toBe('failed');

    // Two more passes exhaust MAX_ATTEMPTS for b…
    await svc.deliverPending();
    await svc.deliverPending();
    const { data: bRow } = await supabase.from('benefit_notices').select('*').eq('id', b.id).single();
    expect(bRow.delivery_attempts).toBe(svc.MAX_ATTEMPTS);

    // …after which it is no longer retried.
    const pass4 = await svc.deliverPending();
    expect(pass4.find(o => o.id === b.id)).toBeUndefined();
  });

  it('queueNotice leaves translation-blocked rows blocked', async () => {
    const { notices } = await noticeTemplates.generateNotice('claim_accepted', CLAIM, {}, { includeSpanish: true });
    const es = notices.find(x => x.language === 'es');
    const after = await svc.queueNotice(es.id);
    expect(after.status).toBe('blocked_pending_translation');
  });
});

describe('webhook tracking', () => {
  it('recordDeliveryEvent flips delivered on the vendor callback', async () => {
    const n = await workerNotice();
    const updated = await svc.recordDeliveryEvent(n.id, 'delivered');
    expect(updated.status).toBe('delivered');
  });
});
