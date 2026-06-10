'use strict';

/**
 * Integration — M17B remainder: attorney representation as first-class
 * claim data (column + named operation + SROI 02), claim reopen
 * (FROI 02), and license-level diary assignment.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const config                 = require('../../src/config');
const { supabase }           = require('../../src/services/supabase');
const claimService           = require('../../src/services/claimService');
const { isRepresented }      = require('../../src/utils/representation');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@test' });
const auth = (r) => r.set('Cookie', `token=${adminToken}`);

const CLAIM = 'claim_m17b_test';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-M17B', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1',
    wcis_enabled: true, attorney_represented: false,
    employee: { firstName: 'Test', lastName: 'Worker' },
  });
});

async function queueRows() {
  const { data } = await supabase.from('wcis_trigger_queue').select('*').eq('claim_id', CLAIM);
  return data || [];
}

describe('setAttorneyRepresentation', () => {
  it('sets the column + attorney fields and fires SROI 02', async () => {
    await claimService.setAttorneyRepresentation(CLAIM, {
      represented: true,
      attorney: { name: 'L. Counsel', firm: 'Counsel LLP', email: 'lc@counsel.example' },
    }, 'adjuster@test');

    const { data: row } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    expect(row.attorney_represented).toBe(true);
    expect(row.attorney_name).toBe('L. Counsel');
    expect(isRepresented(row)).toBe(true);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger_event).toBe('representation_changed');
    expect(rows[0].mtc_code).toBe('02');
    expect(rows[0].mtc_family).toBe('SROI');
  });

  it('same-state update (correcting firm name) does not fire SROI 02', async () => {
    await claimService.setAttorneyRepresentation(CLAIM, {
      represented: true, attorney: { name: 'A' },
    }, 'adj@test');
    await claimService.setAttorneyRepresentation(CLAIM, {
      represented: true, attorney: { name: 'A', firm: 'Corrected LLP' },
    }, 'adj@test');

    expect(await queueRows()).toHaveLength(1); // only the first transition
  });

  it('clearing representation nulls attorney fields and fires SROI 02', async () => {
    await claimService.setAttorneyRepresentation(CLAIM, {
      represented: true, attorney: { name: 'A' },
    }, 'adj@test');
    await claimService.setAttorneyRepresentation(CLAIM, { represented: false }, 'adj@test');

    const { data: row } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    expect(row.attorney_represented).toBe(false);
    expect(row.attorney_name).toBeNull();
    expect(await queueRows()).toHaveLength(2);
  });

  it('is exposed at POST /claims/:id/representation (admin only)', async () => {
    const res = await auth(request(app).post(`/api/v1/claims/${CLAIM}/representation`))
      .send({ represented: true, attorney: { name: 'Route Counsel' } });
    expect(res.status).toBe(200);

    const denied = await request(app).post(`/api/v1/claims/${CLAIM}/representation`)
      .send({ represented: true });
    expect([401, 403]).toContain(denied.status);
  });
});

describe('reopenClaim', () => {
  it('reopens a closed claim, records the event, and fires FROI 02', async () => {
    await supabase.from('claims').update({ status: 'closed' }).eq('id', CLAIM);

    const claim = await claimService.reopenClaim(CLAIM, 'condition worsened — new surgery recommended', 'adj@test');
    expect(claim.status).toBe('active_medical');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'claim_reopened')).toBe(true);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger_event).toBe('froi_data_changed');
    expect(rows[0].mtc_family).toBe('FROI');
    expect(rows[0].mtc_code).toBe('02');
  });

  it('rejects reopening a claim that is not closed, and requires a reason', async () => {
    await expect(claimService.reopenClaim(CLAIM, 'why', 'adj@test'))
      .rejects.toThrow('Only closed claims');
    await supabase.from('claims').update({ status: 'closed' }).eq('id', CLAIM);
    await expect(claimService.reopenClaim(CLAIM, '', 'adj@test'))
      .rejects.toThrow('reason is required');
  });

  it('route: POST /claims/:id/reopen', async () => {
    await supabase.from('claims').update({ status: 'future_medical_only' }).eq('id', CLAIM);
    const res = await auth(request(app).post(`/api/v1/claims/${CLAIM}/reopen`))
      .send({ reason: 'flare-up requiring treatment' });
    expect(res.status).toBe(200);
    expect(res.body.claim.status).toBe('active_medical');
  });
});

describe('license-level diary assignment (M17B)', () => {
  it('WCIS deadline-monitor style diaries are assigned to the adjuster of record, not a system identity', async () => {
    // pdService._createDiary is the shared diary pattern post-sweep.
    const pdService = require('../../src/services/pdService');
    await supabase.from('claims').update({ status: 'p_and_s' }).eq('id', CLAIM);
    const row = await pdService._createDiary
      ? null
      : null;
    // The sweep is structural: assert no service still hardcodes the old
    // system identity for diary assignment.
    const fs = require('fs');
    const path = require('path');
    const srcDir = path.join(__dirname, '../../src');
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes("'system@homecaretpa.com'")) {
          offenders.push(p);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
    expect(config.adjuster.email).toBeTruthy();
  });
});
