'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');

const request = require('supertest');
const app = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../__mocks__/supabaseClient');

const authorization = `Bearer ${generateAdminToken({ sub: 'validation-test-admin' })}`;

beforeEach(() => supabase._resetStore());

test.each([
  ['/api/v1/staffing/agencies', 'name', 'staffing_agencies'],
  ['/api/v1/financials/loss-funds', 'employerId', 'loss_fund_accounts'],
])('%s rejects incomplete requests before creating records', async (path, field, table) => {
  const response = await request(app).post(path).set('Authorization', authorization).send({});
  expect(response.status).toBe(400);
  expect(response.body.errors.some(detail => detail.path === field)).toBe(true);
  const { data } = await supabase.from(table).select('*');
  expect(data).toEqual([]);
});
