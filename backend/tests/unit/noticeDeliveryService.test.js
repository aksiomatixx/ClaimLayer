'use strict';

/**
 * Unit tests — Notice Delivery Orchestration (truthful state model).
 *
 * Channel resolution, per-channel state tracking, the verified portal
 * adapter, the submitted-not-delivered mail stub, webhook-confirmed
 * physical delivery, partial delivery, retry semantics that never
 * resend a successful channel, duplicate-webhook idempotency, and
 * concurrent-worker claiming.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockSendLetter = jest.fn();
jest.mock('../../src/services/lobService', () => ({
  sendLetter: (...a) => mockSendLetter(...a),
  getLetterStatus: jest.fn(),
}));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/noticeDeliveryService');
const noticeTemplates = require('../../src/services/noticeTemplateService');

const CLAIM = 'claim_delivery_test';

beforeEach(async () => {
  supabase._resetStore();
  mockSendLetter.mockReset();
  let seq = 0;
  mockSendLetter.mockImplementation(async () => ({
    letterId: `ltr_MOCK-${++seq}`, status: 'queued', estimatedDelivery: '2026-06-15',
  }));
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

function lobEvent(letterId, type, eventId) {
  return {
    id: eventId || `evt_${Math.random().toString(36).slice(2)}`,
    event_type: { id: type },
    body: { id: letterId },
  };
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

describe('truthful delivery states', () => {
  it('stub mode: a queued Lob letter means SUBMITTED, never delivered', async () => {
    const n = await workerNotice();
    const updated = await svc.deliverNotice(n.id, {});

    // Portal verified+delivered, mail merely submitted → notice is
    // 'submitted', awaiting the provider confirmation.
    expect(updated.status).toBe('submitted');
    expect(updated.delivered_at).toBeFalsy();
    expect(updated.submitted_at).toBeTruthy();

    const channels = await svc.listChannels(n.id);
    const mail = channels.find(c => c.channel === 'mail');
    const portal = channels.find(c => c.channel === 'portal');
    expect(mail.status).toBe('submitted');
    expect(mail.provider_ref).toMatch(/^ltr_MOCK-/);
    expect(mail.delivered_at).toBeFalsy();
    expect(portal.status).toBe('delivered');

    // No notice_delivered event yet — nothing has been delivered.
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'notice_delivered')).toBe(false);
  });

  it('only the verified provider delivery event moves mail to delivered', async () => {
    const n = await workerNotice();
    await svc.deliverNotice(n.id, {});
    const mail = (await svc.listChannels(n.id)).find(c => c.channel === 'mail');

    const result = await svc.recordLobEvent(lobEvent(mail.provider_ref, 'letter.delivered'));
    expect(result.recorded).toBe(true);
    expect(result.notice_status).toBe('delivered');

    const { data: row } = await supabase.from('benefit_notices').select('*').eq('id', n.id).single();
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).toBeTruthy();

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'notice_delivered')).toBe(true);
  });

  it('progress events (in transit) change no delivery truth', async () => {
    const n = await workerNotice();
    await svc.deliverNotice(n.id, {});
    const mail = (await svc.listChannels(n.id)).find(c => c.channel === 'mail');

    const r = await svc.recordLobEvent(lobEvent(mail.provider_ref, 'letter.in_transit'));
    expect(r.progress).toBe('letter.in_transit');

    const { data: row } = await supabase.from('benefit_notices').select('*').eq('id', n.id).single();
    expect(row.status).toBe('submitted');
  });

  it('returned mail fails the channel and surfaces a CRITICAL diary', async () => {
    const n = await workerNotice();
    await svc.deliverNotice(n.id, {});
    const mail = (await svc.listChannels(n.id)).find(c => c.channel === 'mail');

    await svc.recordLobEvent(lobEvent(mail.provider_ref, 'letter.returned_to_sender'));

    const { data: row } = await supabase.from('benefit_notices').select('*').eq('id', n.id).single();
    expect(row.status).toBe('failed');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    const esc = diaries.find(d => d.diary_type === 'NOTICE_DELIVERY_FAILED');
    expect(esc).toBeTruthy();
    expect(esc.priority).toBe('CRITICAL');
  });

  it('duplicate webhooks are acknowledged without reprocessing', async () => {
    const n = await workerNotice();
    await svc.deliverNotice(n.id, {});
    const mail = (await svc.listChannels(n.id)).find(c => c.channel === 'mail');

    const evt = lobEvent(mail.provider_ref, 'letter.delivered', 'evt_dup_1');
    const first = await svc.recordLobEvent(evt);
    expect(first.recorded).toBe(true);

    const again = await svc.recordLobEvent(evt);
    expect(again).toEqual({ duplicate: true });

    // Exactly one delivered event despite two webhook deliveries.
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.filter(e => e.type === 'notice_delivered')).toHaveLength(1);
  });

  it('portal delivery verifies the document is actually available', async () => {
    const n = await workerNotice();
    // Sabotage the filed document: supersede it.
    await supabase.from('claim_documents')
      .update({ status: 'superseded' }).eq('id', n.document_id);

    const updated = await svc.deliverNotice(n.id, { method: 'portal' });
    expect(updated.status).toBe('failed');
    expect(updated.last_error).toContain('PORTAL_DOCUMENT_UNAVAILABLE');
  });

  it('vendor-stub channels fail loudly with the error recorded', async () => {
    const n = await workerNotice();
    const updated = await svc.deliverNotice(n.id, { method: 'fax' });
    expect(updated.status).toBe('failed');
    expect(updated.last_error).toContain('FAX_ADAPTER_NOT_CONFIGURED');
    expect(updated.delivery_attempts).toBe(1);
  });

  it('already-delivered notices are idempotent', async () => {
    const n = await workerNotice();
    await svc.deliverNotice(n.id, {});
    const mail = (await svc.listChannels(n.id)).find(c => c.channel === 'mail');
    await svc.recordLobEvent(lobEvent(mail.provider_ref, 'letter.delivered'));

    const sendsBefore = mockSendLetter.mock.calls.length;
    const again = await svc.deliverNotice(n.id, {});
    expect(again.status).toBe('delivered');
    expect(mockSendLetter.mock.calls.length).toBe(sendsBefore);
  });

  it('blocked translation rows can never be delivered', async () => {
    const { notices } = await noticeTemplates.generateNotice('claim_accepted', CLAIM, {}, { includeSpanish: true });
    const es = notices.find(x => x.language === 'es');
    await expect(svc.deliverNotice(es.id, {})).rejects.toThrow('blocked pending');
  });
});

describe('partial delivery + retries never resend successful channels', () => {
  it('a failed portal with a submitted mail retries ONLY the failed channel', async () => {
    const n = await workerNotice();
    // Make the portal channel fail on the first pass by removing the
    // document content; mail submits fine.
    const { data: doc } = await supabase
      .from('claim_documents').select('*').eq('id', n.document_id).single();
    await supabase.from('claim_documents')
      .update({ pdf_buffer_b64: null, content_text: null }).eq('id', n.document_id);

    await svc.queueNotice(n.id);
    const pass1 = await svc.deliverNotice(n.id, {});
    expect(pass1.status).toBe('failed'); // failed channel dominates
    let channels = await svc.listChannels(n.id);
    expect(channels.find(c => c.channel === 'mail').status).toBe('submitted');
    expect(channels.find(c => c.channel === 'portal').status).toBe('failed');
    expect(mockSendLetter).toHaveBeenCalledTimes(1);

    // Restore the document; retry pass fixes ONLY the portal channel.
    await supabase.from('claim_documents')
      .update({ pdf_buffer_b64: doc.pdf_buffer_b64 }).eq('id', n.document_id);
    const pass2 = await svc.deliverNotice(n.id, {});

    expect(mockSendLetter).toHaveBeenCalledTimes(1); // mail NOT resent
    channels = await svc.listChannels(n.id);
    expect(channels.find(c => c.channel === 'portal').status).toBe('delivered');
    expect(channels.find(c => c.channel === 'mail').status).toBe('submitted');
    expect(pass2.status).toBe('submitted'); // truthful: still awaiting the mail confirmation

    // Provider confirmation completes the notice.
    const mail = channels.find(c => c.channel === 'mail');
    await svc.recordLobEvent(lobEvent(mail.provider_ref, 'letter.delivered'));
    const { data: row } = await supabase.from('benefit_notices').select('*').eq('id', n.id).single();
    expect(row.status).toBe('delivered');
  });

  it('deliverPending retries failed rows up to MAX_ATTEMPTS, then surfaces a terminal diary', async () => {
    const b = await workerNotice();
    await supabase.from('benefit_notices').update({ method: 'fax', status: 'queued' }).eq('id', b.id);

    await svc.deliverPending();
    await svc.deliverPending();
    await svc.deliverPending();
    const { data: bRow } = await supabase.from('benefit_notices').select('*').eq('id', b.id).single();
    expect(bRow.status).toBe('failed');
    expect(bRow.delivery_attempts).toBe(svc.MAX_ATTEMPTS);

    // …after which it is no longer retried…
    const pass4 = await svc.deliverPending();
    expect(pass4.find(o => o.id === b.id)).toBeUndefined();

    // …and the terminal failure is observable.
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.some(d => d.diary_type === 'NOTICE_DELIVERY_FAILED' && d.priority === 'CRITICAL')).toBe(true);
  });

  it('submitted notices are not re-attempted by the retry pass', async () => {
    const n = await workerNotice();
    await svc.queueNotice(n.id);
    await svc.deliverPending();
    expect(mockSendLetter).toHaveBeenCalledTimes(1);

    const again = await svc.deliverPending();
    expect(mockSendLetter).toHaveBeenCalledTimes(1);
    expect(again.find(o => o.id === n.id)).toBeUndefined();
  });

  it('queueNotice leaves translation-blocked rows blocked', async () => {
    const { notices } = await noticeTemplates.generateNotice('claim_accepted', CLAIM, {}, { includeSpanish: true });
    const es = notices.find(x => x.language === 'es');
    const after = await svc.queueNotice(es.id);
    expect(after.status).toBe('blocked_pending_translation');
  });
});

describe('concurrent workers', () => {
  it('two simultaneous delivery passes cannot deliver the same notice twice', async () => {
    const n = await workerNotice();
    await svc.queueNotice(n.id);

    await Promise.all([
      svc.deliverNotice(n.id, { workerId: 'worker-1' }),
      svc.deliverNotice(n.id, { workerId: 'worker-2' }),
    ]);

    // Exactly one Lob submission despite two concurrent workers.
    expect(mockSendLetter).toHaveBeenCalledTimes(1);
    const channels = await svc.listChannels(n.id);
    expect(channels.filter(c => c.channel === 'mail')).toHaveLength(1);
  });

  it('stale locks from a crashed worker are reclaimed and retried', async () => {
    const n = await workerNotice();
    const staleTime = new Date(Date.now() - svc.LOCK_TTL_MS - 60_000).toISOString();
    await supabase.from('benefit_notices')
      .update({ status: 'delivering', locked_by: 'crashed-worker', locked_at: staleTime })
      .eq('id', n.id);

    const outcomes = await svc.deliverPending('rescue-worker');
    const mine = outcomes.find(o => o.id === n.id);
    expect(mine).toBeTruthy();
    expect(['submitted', 'failed']).toContain(mine.status);
  });
});
