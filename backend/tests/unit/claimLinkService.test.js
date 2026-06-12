'use strict';

/**
 * Claim Linking (CL-DEMO2): symmetric links, normalized-pair
 * idempotence, the listing shape the drawer renders, validation, and
 * the admin endpoint.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request = require('supertest');
const app = require('../../src/index');
const { generateAdminToken, generateMagicToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/claimLinkService');

const ADMIN = `Bearer ${generateAdminToken({ sub: 'adm', email: 'adjuster@test' })}`;

const A = 'claim_link_2026';
const B = 'claim_link_2024';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: A, claim_number: 'HHW-2026-D03', status: 'under_investigation',
    date_of_injury: '2026-06-03', body_part: 'Shoulder', employer_id: 'emp-1',
    employee: { adpEmployeeId: 'DEMO-3' },
  });
  await supabase.from('claims').insert({
    id: B, claim_number: 'HHW-2024-D09', status: 'closed',
    date_of_injury: '2024-03-12', body_part: 'Shoulder', employer_id: 'emp-1',
    employee: { adpEmployeeId: 'DEMO-3' },
  });
});

describe('createLink', () => {
  it('is symmetric: one row surfaces on both claims', async () => {
    await svc.createLink(A, B, { note: 'same worker' }, 'adj@test');

    const fromA = await svc.listLinks(A);
    const fromB = await svc.listLinks(B);
    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(fromA[0].linked_claim.id).toBe(B);
    expect(fromB[0].linked_claim.id).toBe(A);
    expect(fromA[0].link_id).toBe(fromB[0].link_id); // the SAME link
  });

  it('normalizes the pair: a reversed re-link is idempotent, not a duplicate', async () => {
    const first = await svc.createLink(A, B, {}, 'a');
    const reversed = await svc.createLink(B, A, {}, 'a');
    expect(reversed.id).toBe(first.id);

    const { data: rows } = await supabase.from('claim_links').select('*');
    expect(rows).toHaveLength(1);
  });

  it('rejects self-links, unknown claims, and unknown relation types', async () => {
    await expect(svc.createLink(A, A, {}, 'a')).rejects.toThrow('two distinct claims');
    await expect(svc.createLink(A, 'claim_ghost', {}, 'a')).rejects.toThrow('Claim not found');
    await expect(svc.createLink(A, B, { relation_type: 'duplicate_of' }, 'a'))
      .rejects.toThrow('relation_type must be one of');
  });

  it('documents the link on both claims\' event streams', async () => {
    await svc.createLink(A, B, { note: 'prior shoulder' }, 'adj@test');
    for (const cid of [A, B]) {
      const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', cid);
      const ev = events.find(e => e.type === 'claim_linked');
      expect(ev).toBeTruthy();
      expect(ev.data.linked_claim_id).toBe(cid === A ? B : A);
    }
  });
});

describe('listLinks shape', () => {
  it('carries the linked claim\'s number, DOI, body part, and status', async () => {
    await svc.createLink(A, B, { note: 'compare PR-1 findings' }, 'a');
    const [link] = await svc.listLinks(A);
    expect(link.relation_type).toBe('prior_claim_same_worker');
    expect(link.note).toContain('PR-1');
    expect(link.linked_claim).toEqual({
      id: B, claim_number: 'HHW-2024-D09', date_of_injury: '2024-03-12',
      body_part: 'Shoulder', status: 'closed',
    });
  });

  it('a claim with no links returns an empty list', async () => {
    expect(await svc.listLinks(A)).toEqual([]);
  });
});

describe('GET /api/v1/claims/:id/links', () => {
  it('returns the links for admins', async () => {
    await svc.createLink(A, B, {}, 'a');
    const res = await request(app).get(`/api/v1/claims/${A}/links`).set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(1);
    expect(res.body.links[0].linked_claim.claim_number).toBe('HHW-2024-D09');
  });

  it('is admin-only', async () => {
    const emp = `Bearer ${generateMagicToken({ sub: 'e', claimId: A })}`;
    const res = await request(app).get(`/api/v1/claims/${A}/links`).set('Authorization', emp);
    expect(res.status).toBe(403);
  });
});
