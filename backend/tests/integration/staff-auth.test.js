'use strict';

/**
 * Integration tests — staff Supabase-Auth login + MFA enforcement + tenant in session.
 *
 *   POST /api/v1/auth/login        — staff (admin/adjuster/supervisor) login
 *   POST /api/v1/auth/login/mfa    — complete login from an AAL2 token
 *   requireMFA                     — no-op without SUPABASE_URL (dev/test/demo)
 *
 * Supabase Auth is mocked (tests/__mocks__/supabaseClient.js).
 *
 * Run: npm test -- tests/integration/staff-auth.test.js
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../../src/index');
const config  = require('../../src/config');
const { requireMFA } = require('../../src/middleware/auth');

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';

// Pull the session JWT out of the Set-Cookie header.
function cookieToken(res) {
  const setCookie = res.headers['set-cookie'] || [];
  const m = setCookie.map(c => /(?:^|;)\s*token=([^;]+)/.exec(c)).find(Boolean);
  return m ? decodeURIComponent(m[1]) : null;
}

describe('POST /api/v1/auth/login (staff)', () => {
  it('logs in a staff user and mints a session carrying role + tenantId', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adjuster@homecaretpa.com', password: 'test1234' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, role: 'admin', mfa: false, tenant_id: DEFAULT_TENANT });

    const decoded = jwt.verify(cookieToken(res), config.jwtSecret);
    expect(decoded.role).toBe('admin');
    expect(decoded.tenantId).toBe(DEFAULT_TENANT);
    expect(decoded.mfa).toBe(false);
  });

  it('rejects a non-staff (employer) user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'hr@brightcarehh.com', password: 'test1234' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_staff');
  });

  it('rejects invalid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adjuster@homecaretpa.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('requires MFA (no session) when the user has a verified factor', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'mfa-admin@homecaretpa.com', password: 'test1234' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('mfa_required');
    expect(res.body.factor_id).toBe('factor-totp-1');
    expect(cookieToken(res)).toBeNull(); // no cookie until MFA is completed
  });
});

describe('POST /api/v1/auth/login/mfa', () => {
  it('completes login from an AAL2 token and marks the session mfa:true', async () => {
    // The client obtains this token by completing the Supabase TOTP challenge.
    const aal2Token = jwt.sign({ sub: 'user-staff-mfa', aal: 'aal2' }, 'supabase-signs-this');

    const res = await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ access_token: aal2Token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, role: 'admin', mfa: true, tenant_id: DEFAULT_TENANT });
    const decoded = jwt.verify(cookieToken(res), config.jwtSecret);
    expect(decoded.mfa).toBe(true);
    expect(decoded.tenantId).toBe(DEFAULT_TENANT);
  });

  it('rejects a token that is not AAL2 (MFA not completed)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ access_token: 'mock-access-token-user-staff-mfa' }); // no aal claim
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('mfa_incomplete');
  });

  it('rejects an unknown token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ access_token: jwt.sign({ sub: 'nobody', aal: 'aal2' }, 'x') });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});

describe('requireMFA middleware', () => {
  const origUrl = process.env.SUPABASE_URL;
  afterEach(() => { if (origUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = origUrl; });

  it('is a no-op when SUPABASE_URL is unset (dev/test/demo)', () => {
    delete process.env.SUPABASE_URL;
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    requireMFA({ user: { role: 'admin' } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a non-MFA session when SUPABASE_URL is set', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    requireMFA({ user: { role: 'admin', mfa: false } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows an MFA-elevated session when SUPABASE_URL is set', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    requireMFA({ user: { role: 'admin', mfa: true } }, res, next);
    expect(next).toHaveBeenCalled();
  });
});
