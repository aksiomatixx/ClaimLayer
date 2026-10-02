'use strict';

/**
 * Security tests — server-authoritative identity (finding S-1, ADR-0002).
 *
 * Supabase user_metadata is writable by the user. These tests prove that a
 * self-asserted role / tenant / employer can never become a session claim:
 * login reads only the provisioned public.users row.
 *
 * Fixtures: tests/__mocks__/supabaseClient.js — `self-promoted@attacker.test`
 * (metadata role=admin, never provisioned), `escalated@brightcarehh.com`
 * (provisioned employer who rewrote metadata to admin + another employer +
 * another tenant), `former-adjuster@homecaretpa.com` (deactivated).
 *
 * Run: npm test -- tests/security/identity-hardening.test.js
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../../src/index');
const config  = require('../../src/config');
const { _provisionAuthUsers } = require('../__mocks__/supabaseClient');

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const ATTACKER_TENANT = '00000000-0000-0000-0000-0000000000b2';

function sessionFrom(res) {
  const setCookie = res.headers['set-cookie'] || [];
  const m = setCookie.map(c => /(?:^|;)\s*token=([^;]+)/.exec(c)).find(Boolean);
  return m ? jwt.decode(decodeURIComponent(m[1])) : null;
}

beforeEach(() => _provisionAuthUsers());

describe('staff login ignores self-asserted user_metadata', () => {
  test('an unprovisioned account claiming role=admin in metadata gets no session', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'self-promoted@attacker.test', password: 'test1234' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_provisioned');
    expect(sessionFrom(res)).toBeNull();
  });

  test('a provisioned employer who rewrote metadata to admin cannot obtain a staff session', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'escalated@brightcarehh.com', password: 'test1234' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_staff');
    expect(sessionFrom(res)).toBeNull();
  });

  test('a deactivated staff user cannot log in even with valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'former-adjuster@homecaretpa.com', password: 'test1234' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('account_inactive');
    expect(sessionFrom(res)).toBeNull();
  });

  test('the MFA completion path applies the same provisioning check', async () => {
    const aal2 = jwt.sign({ sub: 'user-self-promoted', aal: 'aal2' }, 'supabase-test-secret');
    const res = await request(app).post('/api/v1/auth/login/mfa').send({ access_token: aal2 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_provisioned');
    expect(sessionFrom(res)).toBeNull();
  });

  test('a provisioned staff session carries the provisioned role and tenant', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'adjuster@homecaretpa.com', password: 'test1234' });
    expect(res.status).toBe(200);
    const session = sessionFrom(res);
    expect(session.role).toBe('admin');
    expect(session.tenantId).toBe(DEFAULT_TENANT);
  });
});

describe('employer login ignores self-asserted user_metadata', () => {
  test('employer, tenant and role come from the users row, not metadata', async () => {
    const res = await request(app).post('/api/v1/auth/employer/login')
      .send({ email: 'escalated@brightcarehh.com', password: 'test1234' });
    expect(res.status).toBe(200);
    const session = sessionFrom(res);
    expect(session.role).toBe('employer');
    expect(session.employerId).toBe('employer-brightcare-001');   // not employer-carewell-001
    expect(session.tenantId).toBe(DEFAULT_TENANT);                  // not the asserted tenant
    expect(session.tenantId).not.toBe(ATTACKER_TENANT);
    expect(res.body.employer_name).toBe('BrightCare Home Health');
  });

  test('an unprovisioned account gets the uniform invalid_credentials response', async () => {
    const res = await request(app).post('/api/v1/auth/employer/login')
      .send({ email: 'self-promoted@attacker.test', password: 'test1234' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(sessionFrom(res)).toBeNull();
  });

  test('a staff account cannot use the employer portal login', async () => {
    const res = await request(app).post('/api/v1/auth/employer/login')
      .send({ email: 'adjuster@homecaretpa.com', password: 'test1234' });
    expect(res.status).toBe(401);
    expect(sessionFrom(res)).toBeNull();
  });
});

describe('session cookie transport (finding S-8)', () => {
  const original = config.nodeEnv;
  afterEach(() => { config.nodeEnv = original; });

  test('the session cookie is Secure in production', async () => {
    config.nodeEnv = 'production';
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'adjuster@homecaretpa.com', password: 'test1234' });
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('token='));
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });

  test('outside production the cookie still works over plain-HTTP localhost', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'adjuster@homecaretpa.com', password: 'test1234' });
    const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('token='));
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });
});
