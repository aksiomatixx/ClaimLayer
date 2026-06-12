'use strict';

/**
 * captureDemoFixtures.js — regenerate the static demo's API snapshot.
 *
 * The website's interactive demo is the real frontend with a fetch shim
 * that answers GETs from frontend/src/demo/fixtures.json. This script
 * rebuilds that snapshot from the CURRENT seed: it boots the express
 * app against the in-memory test DB, seeds the demo book, performs
 * every GET the demo UI issues, and writes the responses keyed exactly
 * the way fetchShim.js looks them up ("GET <path><search>").
 *
 * Run whenever the demo seed changes, then rebuild the demo bundle:
 *   node backend/src/scripts/captureDemoFixtures.js
 *   node backend/src/scripts/generateDemoFilePdfs.js
 *   cd frontend && npm run build:demo
 *
 * Hermetic: in-memory DB, no model calls, no network.
 */

process.env.NODE_ENV = 'test';
// Throwaway signing secret: the capture runs entirely in-process, and
// only the response BODIES are kept — no token reaches the snapshot.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-capture-throwaway';

const fs   = require('fs');
const path = require('path');

const supaPath = require.resolve('../services/supabase');
const mockSupa = require('../../tests/__mocks__/supabaseClient');
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: mockSupa };

const request      = require('supertest');
const { seedDemo } = require('./seedDemo');
const { makeClaimId } = require('./demoData');
const { supabase } = mockSupa;

const OUT = path.resolve(__dirname, '../../../frontend/src/demo/fixtures.json');

async function main() {
  await seedDemo();

  const app = require('../index');
  const { generateAdminToken, generateSupervisorToken } = require('../middleware/auth');
  const cookie = `token=${generateAdminToken({ sub: 'demo-capture', email: 'admin@homecaretpa.com' })}`;
  // The supervisor digest is role-gated; capture it as the seeded supervisor.
  const supervisorCookie = `token=${generateSupervisorToken({ sub: 'demo-capture-sup', email: 'supervisor@homecaretpa.com' })}`;

  // Per-claim drawer endpoints, for every lifecycle claim plus the
  // linked 2024 prior claim (009).
  const claimIds = [];
  for (let i = 0; i < 12; i++) claimIds.push(makeClaimId(i));
  claimIds.splice(8, 0, 'claim_demo_009'); // keep 001..009..013 reading order

  const perClaim = (id) => [
    `/api/v1/claims/${id}`,
    `/api/v1/claims/${id}/diaries`,
    `/api/v1/claims/${id}/documents`,
    `/api/v1/claims/${id}/decision-brief`,
    `/api/v1/claims/${id}/td-periods`,
    `/api/v1/claims/${id}/td-summary`,
    `/api/v1/mmi/claim/${id}`,
    `/api/v1/mmi/pr4/claim/${id}`,
    `/api/v1/pd/claim/${id}`,
    `/api/v1/qme/claim/${id}`,
    `/api/v1/qme/supplementals/${id}`,
    `/api/v1/claims/${id}/reserve-worksheet`,
    `/api/v1/claims/${id}/links`,
  ];

  // Every open diary's dry-run preview (the decision loop's "exactly
  // what completing will do" panel).
  const { data: diaries } = await supabase.from('diaries').select('*');
  const diaryPreviews = (diaries || [])
    .filter(d => d.status === 'open')
    .map(d => `/api/v1/diaries/${d.id}/aftermath-preview`);

  // Every seeded agent decision, plus the prompt text the console
  // shows beside it.
  const { data: decisions } = await supabase.from('ai_decisions').select('*');
  const decisionDetails = (decisions || []).map(d => `/api/v1/ai-decisions/${d.id}`);
  const promptNames = [...new Set((decisions || []).map(d => d.prompt_name))];
  const promptUrls = promptNames.map(n => `/api/v1/prompts/${n}`);

  const endpoints = [
    '/api/v1/auth/dev-session',
    '/api/v1/claims',
    ...claimIds.flatMap(perClaim),
    '/api/v1/rfas?status=pending_adjuster_review',
    '/api/v1/rfas?status=approved',
    '/api/v1/rfas?status=routed_to_uro',
    '/api/v1/reports/cross-employer',
    '/api/v1/reports/missed-deadlines',
    '/api/v1/ai-decisions',
    '/api/v1/ai-decisions/stats?window=30',
    ...decisionDetails,
    ...promptUrls,
    '/api/v1/documents/triage',
    '/api/v1/wcis/quality-metrics',
    '/api/v1/insurers',
    '/api/v1/employers/employer-brightcare-001/policies',
    '/api/v1/employers/employer-westside-001/policies',
    ...diaryPreviews,
    '/api/v1/integrations/systems',
    '/api/v1/integrations/migrated',
    '/api/v1/supervisor/alerts/current',
  ];

  const fixtures = {};
  const misses = [];
  for (const url of endpoints) {
    const auth = url.startsWith('/api/v1/supervisor/') ? supervisorCookie : cookie;
    const res = await request(app).get(url).set('Cookie', auth);
    if (res.status === 200) {
      fixtures[`GET ${url}`] = res.body;
    } else {
      misses.push(`${res.status} ${url}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(fixtures, null, 1) + '\n');
  // eslint-disable-next-line no-console
  console.log(`✓ captured ${Object.keys(fixtures).length} fixtures → ${path.relative(process.cwd(), OUT)}`);
  if (misses.length) {
    // eslint-disable-next-line no-console
    console.log(`  skipped (non-200):\n    ${misses.join('\n    ')}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('✗ captureDemoFixtures failed:', err.message);
  process.exit(1);
});
