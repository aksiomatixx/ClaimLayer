'use strict';

/**
 * Webhook body handling + signature verification (Finding 8 of the
 * production-hardening pass).
 *
 * The webhooks router mounts BEFORE the global JSON parser, so HMAC
 * verification runs over the EXACT raw request bytes. The tests below
 * prove it: bodies with altered whitespace and key ordering only verify
 * when the signature was computed over those same bytes — a signature
 * over the re-serialized JSON fails.
 *
 * Production fails closed (missing secret or signature → 401); the
 * non-production bypass is explicit and applies only when no secret is
 * configured for that webhook.
 */

// Secrets must exist before the app (and config) are required.
process.env.DXF_WEBHOOK_SECRET = 'dxf-test-secret';
process.env.LOB_WEBHOOK_SECRET = 'lob-test-secret';
delete process.env.ENLYTE_WEBHOOK_SECRET; // exercises the no-secret paths

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const crypto  = require('crypto');
const request = require('supertest');
const app     = require('../../src/index');
const { supabase } = require('../../src/services/supabase');
const noticeTemplates = require('../../src/services/noticeTemplateService');
const noticeDelivery  = require('../../src/services/noticeDeliveryService');

const sign = (secret, raw) =>
  crypto.createHmac('sha256', secret).update(raw).digest('hex');
const lobSign = (secret, ts, raw) =>
  crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');

afterEach(() => {
  process.env.NODE_ENV = 'test';
});

describe('raw-byte HMAC verification (DxF)', () => {
  // Same JSON value, hostile byte layout: odd whitespace + reordered keys.
  const RAW = '{  "facilityName" :"General",\n\t"eventType":   "A03"  }';

  it('accepts a signature computed over the exact raw bytes', async () => {
    const res = await request(app)
      .post('/webhooks/dxf/adt')
      .set('content-type', 'application/json')
      .set('x-medex-signature', sign('dxf-test-secret', RAW))
      .send(RAW);
    expect(res.status).toBe(202);
  });

  it('rejects a signature computed over re-serialized JSON of the same value', async () => {
    const reSerialized = JSON.stringify(JSON.parse(RAW)); // different bytes, same value
    expect(reSerialized).not.toBe(RAW);
    const res = await request(app)
      .post('/webhooks/dxf/adt')
      .set('content-type', 'application/json')
      .set('x-medex-signature', sign('dxf-test-secret', reSerialized))
      .send(RAW);
    expect(res.status).toBe(401);
  });

  it('rejects when one byte of the body changes after signing', async () => {
    const res = await request(app)
      .post('/webhooks/dxf/adt')
      .set('content-type', 'application/json')
      .set('x-medex-signature', sign('dxf-test-secret', RAW))
      .send(RAW + ' ');
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature when a secret is configured', async () => {
    const res = await request(app)
      .post('/webhooks/dxf/adt')
      .set('content-type', 'application/json')
      .send(RAW);
    expect(res.status).toBe(401);
  });
});

describe('fail-closed production / explicit non-production bypass (Enlyte: no secret configured)', () => {
  const BODY = '{"referralId":"r1","determination":"approved"}';

  it('production with no secret fails closed', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app)
      .post('/webhooks/enlyte/determination')
      .set('content-type', 'application/json')
      .send(BODY);
    expect(res.status).toBe(401);
  });

  it('non-production with no secret is an explicit bypass', async () => {
    const res = await request(app)
      .post('/webhooks/enlyte/determination')
      .set('content-type', 'application/json')
      .send(BODY);
    expect(res.status).toBe(202);
  });

  it('production with a secret but no signature fails closed (DxF)', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app)
      .post('/webhooks/dxf/adt')
      .set('content-type', 'application/json')
      .send('{"eventType":"A01"}');
    expect(res.status).toBe(401);
  });
});

describe('Lob delivery webhook', () => {
  const CLAIM = 'claim_lobhook';

  beforeEach(async () => {
    supabase._resetStore();
    await supabase.from('claims').insert({
      id: CLAIM, claim_number: 'HHW-LOB-1', status: 'active_medical',
      date_of_injury: '2026-04-01', employer_id: 'emp-1',
      employee: { firstName: 'Lob', lastName: 'Hook' },
    });
  });

  async function submittedMailChannel() {
    const { notices } = await noticeTemplates.generateNotice('claim_accepted', CLAIM, {});
    await noticeDelivery.deliverNotice(notices[0].id, {});
    const channels = await noticeDelivery.listChannels(notices[0].id);
    return { notice: notices[0], mail: channels.find(c => c.channel === 'mail') };
  }

  function post(rawBody, { ts, sig } = {}) {
    const timestamp = ts ?? Date.now();
    const signature = sig ?? lobSign('lob-test-secret', timestamp, rawBody);
    return request(app)
      .post('/webhooks/lob/delivery')
      .set('content-type', 'application/json')
      .set('lob-signature', signature)
      .set('lob-signature-timestamp', String(timestamp))
      .send(rawBody);
  }

  it('a verified letter.delivered event flips the mail channel and the notice', async () => {
    const { notice, mail } = await submittedMailChannel();
    expect(mail.status).toBe('submitted');

    const raw = JSON.stringify({ id: 'evt_route_1', event_type: { id: 'letter.delivered' }, body: { id: mail.provider_ref } });
    const res = await post(raw);
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);

    const { data: row } = await supabase.from('benefit_notices').select('*').eq('id', notice.id).single();
    expect(row.status).toBe('delivered');
  });

  it('rejects a tampered body even with a once-valid signature', async () => {
    const { mail } = await submittedMailChannel();
    const raw = JSON.stringify({ id: 'evt_route_2', event_type: { id: 'letter.delivered' }, body: { id: mail.provider_ref } });
    const ts = Date.now();
    const res = await request(app)
      .post('/webhooks/lob/delivery')
      .set('content-type', 'application/json')
      .set('lob-signature', lobSign('lob-test-secret', ts, raw))
      .set('lob-signature-timestamp', String(ts))
      .send(raw.replace('letter.delivered', 'letter.returned_x'));
    expect(res.status).toBe(401);
  });

  it('rejects stale timestamps (replay window)', async () => {
    const { mail } = await submittedMailChannel();
    const raw = JSON.stringify({ id: 'evt_route_3', event_type: { id: 'letter.delivered' }, body: { id: mail.provider_ref } });
    const staleTs = Date.now() - 10 * 60 * 1000;
    const res = await post(raw, { ts: staleTs });
    expect(res.status).toBe(401);
  });

  it('duplicate webhook deliveries are idempotent through the route', async () => {
    const { notice, mail } = await submittedMailChannel();
    const raw = JSON.stringify({ id: 'evt_route_4', event_type: { id: 'letter.delivered' }, body: { id: mail.provider_ref } });

    const first = await post(raw);
    expect(first.body.recorded).toBe(true);
    const second = await post(raw);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.filter(e => e.type === 'notice_delivered')).toHaveLength(1);
    void notice;
  });

  it('fails closed in production when the Lob secret is missing', async () => {
    const { mail } = await submittedMailChannel();
    const raw = JSON.stringify({ id: 'evt_route_5', event_type: { id: 'letter.delivered' }, body: { id: mail.provider_ref } });

    const realSecret = process.env.LOB_WEBHOOK_SECRET;
    const config = require('../../src/config');
    const saved = config.webhooks.lobSecret;
    config.webhooks.lobSecret = undefined;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app)
        .post('/webhooks/lob/delivery')
        .set('content-type', 'application/json')
        .send(raw);
      expect(res.status).toBe(401);
    } finally {
      config.webhooks.lobSecret = saved;
      process.env.LOB_WEBHOOK_SECRET = realSecret;
      process.env.NODE_ENV = 'test';
    }
  });
});
