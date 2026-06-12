#!/usr/bin/env node
'use strict';

/**
 * migration-contract-test.js — applies every migration to a REAL
 * (temporary) PostgreSQL database in filename order, re-applies the
 * hardening migration to prove idempotency, then runs schema-contract
 * integration assertions: code-shaped rows for every write path the
 * backend performs, plus the uniqueness/CHECK rules the hardening pass
 * depends on (idempotency keys, webhook dedupe, channel uniqueness,
 * atomic single-use updates).
 *
 * Run locally:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *     node backend/scripts/migration-contract-test.js
 *
 * CI runs this against the postgres:16 service container — code that
 * writes a column no migration created fails HERE, not in production.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Vanilla Postgres lacks the Supabase runtime objects some migrations
// reference (RLS policies use the authenticated role and auth.uid()).
const SUPABASE_SHIMS = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN;
    END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
`;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✕ ${name}\n      ${e.message}`);
  }
}

async function expectViolation(client, name, sql, params) {
  await check(name, async () => {
    try {
      await client.query(sql, params);
    } catch (e) {
      if (/violates|invalid input/i.test(e.message)) return; // expected
      throw e;
    }
    throw new Error('statement succeeded but a constraint violation was expected');
  });
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log('── Supabase shims');
  await client.query(SUPABASE_SHIMS);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  console.log(`── Applying ${files.length} migrations in filename order`);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await client.query(sql);
      console.log(`  ✓ ${f}`);
    } catch (e) {
      console.error(`  ✕ ${f}\n      ${e.message}`);
      await client.end();
      process.exit(1);
    }
  }

  console.log('── Re-applying the hardening-era migrations (idempotency)');
  const hardening = files.filter(f => f.startsWith('20260611'));
  for (const f of hardening) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await client.query(sql);
    console.log(`  ✓ ${f} (second apply)`);
  }

  console.log('── Schema-contract assertions (code-shaped writes)');

  await check('claims accepts the code-generated TEXT id shape', () =>
    client.query(
      `INSERT INTO claims (id, claim_number, employer_id, status, date_of_injury, employee)
       VALUES ('claim_ct_1', 'HHW-2026-CT1', 'employer-ct', 'new_claim', '2026-05-01', '{"firstName":"Contract"}')`));

  await check('diaries accepts diy_* TEXT ids with decision + ceiling + idempotency columns', () =>
    client.query(
      `INSERT INTO diaries (id, claim_id, diary_type, due_date, priority, status,
                            completed_at, completed_by, decision_action, decision_note,
                            parent_diary_id, idempotency_key, statutory_deadline, no_snooze)
       VALUES ('diy_ct_parent', 'claim_ct_1', 'COMPENSABILITY_DECISION_DUE', '2026-07-30', 'CRITICAL', 'completed',
               now(), 'adjuster@test', 'delay', 'contract test',
               NULL, 'succ:diy_ct_0:COMPENSABILITY_DECISION_DUE', '2026-07-30', TRUE)`));

  await expectViolation(client,
    'duplicate successor idempotency keys are rejected (crash-retry safety)',
    `INSERT INTO diaries (id, claim_id, diary_type, status, idempotency_key)
     VALUES ('diy_ct_dup', 'claim_ct_1', 'COMPENSABILITY_DECISION_DUE', 'open',
             'succ:diy_ct_0:COMPENSABILITY_DECISION_DUE')`);

  await check('claim_events accepts evt_* TEXT ids', () =>
    client.query(
      `INSERT INTO claim_events (id, claim_id, type, data)
       VALUES ('evt_ct_1', 'claim_ct_1', 'action_completed', '{"actor":"contract"}')`));

  await check('claim_documents carries generation + triage-resolution fields', () =>
    client.query(
      `INSERT INTO claim_documents (id, claim_id, title, category, status, triage_status,
                                    package_kind, pdf_buffer_b64, rejection_reason, resolved_by, resolved_at)
       VALUES ('doc_ct_1', 'claim_ct_1', 'C&R package (v1)', 'settlement', 'filed', 'none',
               'cnr_10214c', 'JVBERi0=', NULL, NULL, NULL)`));

  await check('claim_documents carries the PDF-intake fields (extraction method + channel envelope)', () =>
    client.query(
      `INSERT INTO claim_documents (id, claim_id, title, category, status, triage_status,
                                    pdf_buffer_b64, extraction_method, channel_metadata)
       VALUES ('doc_ct_pdf', 'claim_ct_1', 'Emailed PR-2.pdf', 'medical', 'filed', 'none',
               'JVBERi0=', 'document_vision', '{"from":"clinic@example.com","subject":"PR-2"}')`));

  await expectViolation(client,
    'extraction_method outside the controlled pair is rejected',
    `INSERT INTO claim_documents (id, title, category, status, triage_status, extraction_method)
     VALUES ('doc_ct_pdf_bad', 'x', 'other', 'filed', 'none', 'ocr_maybe')`);

  await check("claim_documents supports the transient 'resolving' triage state + supersede chain", async () => {
    await client.query(
      `INSERT INTO claim_documents (id, title, category, status, triage_status)
       VALUES ('doc_ct_2', 'Fax fragment', 'other', 'triage', 'resolving')`);
    await client.query(
      `UPDATE claim_documents SET status='superseded', superseded_by='doc_ct_1' WHERE id='doc_ct_2'`);
  });

  await check('diaries.source_document_id FK accepts a filed document', () =>
    client.query(
      `INSERT INTO diaries (id, claim_id, diary_type, status, source_document_id)
       VALUES ('diy_ct_src', 'claim_ct_1', 'TD_PAYMENT_REVIEW', 'open', 'doc_ct_1')`));

  await check("benefit_notices supports 'submitted', locks, and the diary linkage", () =>
    client.query(
      `INSERT INTO benefit_notices (id, claim_id, notice_type, audience, language, recipient,
                                    status, source_diary_id, idempotency_key, locked_by, locked_at, submitted_at)
       VALUES ('bn_ct_1', 'claim_ct_1', 'td_suspension', 'worker', 'en', '{"name":"Contract"}',
               'submitted', 'diy_ct_parent', 'not:diy_ct_parent:td_suspension:worker:en', NULL, NULL, now())`));

  await expectViolation(client,
    'benefit_notices rejects untruthful states outside the model',
    `INSERT INTO benefit_notices (id, claim_id, notice_type, audience, language, recipient, status)
     VALUES ('bn_ct_bad', 'claim_ct_1', 'x', 'worker', 'en', '{}', 'mailed_probably')`);

  await check('benefit_notice_channels tracks per-channel delivery', () =>
    client.query(
      `INSERT INTO benefit_notice_channels (id, notice_id, claim_id, channel, status, provider_ref, attempts, submitted_at)
       VALUES ('bnc_ct_1', 'bn_ct_1', 'claim_ct_1', 'mail', 'submitted', 'ltr_MOCK-1', 1, now())`));

  await expectViolation(client,
    'a second row for the same (notice, channel) is rejected',
    `INSERT INTO benefit_notice_channels (id, notice_id, channel, status)
     VALUES ('bnc_ct_2', 'bn_ct_1', 'mail', 'pending')`);

  await check('webhook_events dedupes on (provider, provider_event_id)', async () => {
    await client.query(
      `INSERT INTO webhook_events (id, provider, provider_event_id, event_type, payload)
       VALUES ('whk_ct_1', 'lob', 'evt_lob_1', 'letter.delivered', '{}')`);
  });
  await expectViolation(client,
    'a duplicate provider event id is rejected',
    `INSERT INTO webhook_events (id, provider, provider_event_id)
     VALUES ('whk_ct_2', 'lob', 'evt_lob_1')`);

  await check('integration_outbox accepts the dispatcher lifecycle', async () => {
    await client.query(
      `INSERT INTO integration_outbox (id, target, operation, claim_id, payload, status, next_attempt_at)
       VALUES ('obx_ct_1', 'filehandler', 'add_note', 'claim_ct_1', '{"note_text":"x"}', 'pending', now())`);
    await client.query(
      `UPDATE integration_outbox SET status='processing', locked_by='w1', locked_at=now() WHERE id='obx_ct_1' AND status='pending'`);
    await client.query(
      `UPDATE integration_outbox SET status='succeeded', succeeded_at=now(), locked_by=NULL WHERE id='obx_ct_1'`);
  });
  await expectViolation(client,
    'outbox rejects unknown statuses',
    `INSERT INTO integration_outbox (id, target, operation, status)
     VALUES ('obx_ct_2', 'filehandler', 'add_note', 'maybe')`);

  await check('reserve_line_items accepts all three line shapes', async () => {
    await client.query(
      `INSERT INTO reserve_line_items (id, claim_id, category, label, shape, quantity, unit_amount, total, basis_note, created_by)
       VALUES ('rli_ct_1', 'claim_ct_1', 'medical', 'PTP visits', 'quantity', 5, 250, 1250, 'per PR-1 plan (synthetic)', 'ct@test')`);
    await client.query(
      `INSERT INTO reserve_line_items (id, claim_id, category, label, shape, quantity, unit_amount, total)
       VALUES ('rli_ct_2', 'claim_ct_1', 'indemnity', 'TD', 'weeks_rate', 6, 414, 2484)`);
    await client.query(
      `INSERT INTO reserve_line_items (id, claim_id, category, label, shape, flat_amount, total)
       VALUES ('rli_ct_3', 'claim_ct_1', 'indemnity', 'Est. PD', 'flat', 7500, 7500)`);
  });
  await expectViolation(client,
    'reserve_line_items rejects categories outside the controlled trio',
    `INSERT INTO reserve_line_items (id, claim_id, category, label, shape, flat_amount, total)
     VALUES ('rli_ct_bad', 'claim_ct_1', 'legal_fees', 'x', 'flat', 1, 1)`);
  await expectViolation(client,
    'a quantity-shaped line without quantity/unit is rejected',
    `INSERT INTO reserve_line_items (id, claim_id, category, label, shape, total)
     VALUES ('rli_ct_bad2', 'claim_ct_1', 'medical', 'x', 'quantity', 0)`);

  await check('claim_links stores a symmetric pair once', async () => {
    await client.query(
      `INSERT INTO claims (id, claim_number, employer_id, status, date_of_injury)
       VALUES ('claim_ct_2', 'HHW-2024-CT2', 'employer-ct', 'closed', '2024-03-12')`);
    await client.query(
      `INSERT INTO claim_links (id, claim_id_a, claim_id_b, relation_type, note)
       VALUES ('clk_ct_1', 'claim_ct_1', 'claim_ct_2', 'prior_claim_same_worker', 'same worker')`);
  });
  await expectViolation(client,
    'a duplicate link for the same pair is rejected',
    `INSERT INTO claim_links (id, claim_id_a, claim_id_b)
     VALUES ('clk_ct_2', 'claim_ct_1', 'claim_ct_2')`);
  await expectViolation(client,
    'self-links are rejected',
    `INSERT INTO claim_links (id, claim_id_a, claim_id_b)
     VALUES ('clk_ct_3', 'claim_ct_1', 'claim_ct_1')`);
  await expectViolation(client,
    'unknown relation types are rejected',
    `INSERT INTO claim_links (id, claim_id_a, claim_id_b, relation_type)
     VALUES ('clk_ct_4', 'claim_ct_2', 'claim_ct_1', 'duplicate_of')`);

  await check('supervisor_alerts stores one digest per supervisor per day', async () => {
    await client.query(
      `INSERT INTO supervisor_alerts (id, alert_date, recipient_user_id, payload, due_today_count, overdue_count)
       VALUES ('sva_ct_1', '2026-06-12', 'supervisor@ct.test', '{"due_today":[],"overdue":[]}', 1, 2)`);
  });
  await expectViolation(client,
    'a second digest for the same supervisor/date is rejected (idempotent upsert target)',
    `INSERT INTO supervisor_alerts (id, alert_date, recipient_user_id)
     VALUES ('sva_ct_2', '2026-06-12', 'supervisor@ct.test')`);
  await expectViolation(client,
    'negative digest counts are rejected',
    `INSERT INTO supervisor_alerts (id, alert_date, recipient_user_id, due_today_count)
     VALUES ('sva_ct_3', '2026-06-13', 'supervisor@ct.test', -1)`);

  await check('magic-link single use is atomic (conditional update wins exactly once)', async () => {
    await client.query(
      `INSERT INTO magic_link_tokens (jti, claim_id, adp_employee_id, expires_at)
       VALUES ('jti_ct_1', 'claim_ct_1', 'ADP-CT-1', now() + interval '72 hours')`);
    const first = await client.query(
      `UPDATE magic_link_tokens SET used_at = now() WHERE jti = 'jti_ct_1' AND used_at IS NULL RETURNING jti`);
    const second = await client.query(
      `UPDATE magic_link_tokens SET used_at = now() WHERE jti = 'jti_ct_1' AND used_at IS NULL RETURNING jti`);
    if (first.rowCount !== 1 || second.rowCount !== 0) {
      throw new Error(`expected exactly one winner, got ${first.rowCount}/${second.rowCount}`);
    }
  });

  await check('media documents + appointments carry the columns the routes write', async () => {
    await client.query(
      `INSERT INTO documents (claim_id, doc_type, source, storage_path, upload_confirmed_at)
       VALUES ('claim_ct_1', 'photo', 'employee_upload', 'claims/x/y.jpg', now())`);
    await client.query(
      `INSERT INTO appointments (claim_id, provider_id, status, confirmation_number)
       VALUES ('claim_ct_1', 'prov_001', 'confirmed', 'CONF-CT-1')`);
  });

  await client.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
