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

async function expectError(client, name, sql, pattern, params) {
  await check(name, async () => {
    try {
      await client.query(sql, params);
    } catch (e) {
      if (pattern.test(e.message)) return;
      throw new Error(`unexpected error: ${e.message}`);
    }
    throw new Error('statement succeeded but an error was expected');
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

  console.log('── Re-applying the hardening-era + trust-foundation migrations (idempotency)');
  const hardening = files.filter(f => f.startsWith('20260611') || f.startsWith('20261001'));
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

  await check('audit_log accepts the actor identity the services write', async () => {
    // Regression (Codex sweep A1): diary actions, document ingestion, and
    // supervisor-alert acknowledgement all insert `actor` — the column
    // must exist or every one of those writes fails on real PostgreSQL.
    await client.query(
      `INSERT INTO audit_log (action, resource_type, resource_id, description, actor)
       VALUES ('supervisor_alert_acknowledged', 'supervisor_alert', 'sva_ct_1', 'contract test', 'supervisor@ct.test')`);
    const { rows } = await client.query(
      `SELECT actor FROM audit_log WHERE resource_id = 'sva_ct_1'`);
    if (rows[0]?.actor !== 'supervisor@ct.test') throw new Error('actor column did not round-trip');
  });

  await check('webhook_events carries processed_at (processing-state idempotency)', async () => {
    await client.query(
      `INSERT INTO webhook_events (id, provider, provider_event_id, event_type)
       VALUES ('whk_ct_3', 'lob', 'evt_ct_1', 'letter.delivered')`);
    await client.query(
      `UPDATE webhook_events SET processed_at = now() WHERE id = 'whk_ct_3'`);
    const { rows } = await client.query(
      `SELECT processed_at FROM webhook_events WHERE id = 'whk_ct_3'`);
    if (!rows[0]?.processed_at) throw new Error('processed_at did not persist');
  });

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

  console.log('── Multi-tenancy: tenant-isolation RLS proof');

  await check('default tenant + tenant_id columns exist', async () => {
    const t = await client.query(`SELECT 1 FROM tenants WHERE slug = 'default'`);
    if (!t.rowCount) throw new Error('default tenant row missing');
    const c = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'claims' AND column_name = 'tenant_id'`);
    if (!c.rowCount) throw new Error('claims.tenant_id missing');
  });

  await check('RLS confines each tenant to its own claims (cross-tenant rows are invisible)', async () => {
    // Resolve auth.uid() from a session GUC so this proof can simulate two
    // authenticated users; production gets a real auth.uid() from Supabase Auth.
    await client.query(
      `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
       AS $$ SELECT NULLIF(current_setting('app.test_uid', true), '')::uuid $$`);

    // A second tenant, an admin in each tenant, and a claim in tenant B
    // (claim_ct_1 already lives in the default tenant — "tenant A").
    await client.query(
      `INSERT INTO tenants (id, name, slug)
       VALUES ('00000000-0000-0000-0000-0000000000b2', 'Tenant B', 'tenant-b')
       ON CONFLICT (id) DO NOTHING`);
    await client.query(
      `INSERT INTO users (id, email, role, tenant_id) VALUES
         ('00000000-0000-0000-0000-00000000a001', 'admin-a@ct.test', 'admin', '00000000-0000-0000-0000-000000000001'),
         ('00000000-0000-0000-0000-0000000000b1', 'admin-b@ct.test', 'admin', '00000000-0000-0000-0000-0000000000b2')
       ON CONFLICT (id) DO NOTHING`);
    await client.query(
      `INSERT INTO claims (id, claim_number, status, date_of_injury, tenant_id)
       VALUES ('claim_tb_1', 'HHW-2026-TB1', 'new_claim', '2026-05-02', '00000000-0000-0000-0000-0000000000b2')`);

    // Wide-open permissive SELECT policy so the ONLY filter under test is the
    // tenant RESTRICTIVE policy (decoupled from the role policies). The
    // authenticated role needs read grants the vanilla shim doesn't ship.
    await client.query(`DROP POLICY IF EXISTS tmp_ct_allow_all ON claims`);
    await client.query(
      `CREATE POLICY tmp_ct_allow_all ON claims AS PERMISSIVE FOR SELECT TO authenticated USING (true)`);
    await client.query(`GRANT USAGE ON SCHEMA public TO authenticated`);
    await client.query(`GRANT SELECT ON claims TO authenticated`);

    try {
      await client.query(`SET ROLE authenticated`);

      await client.query(`SELECT set_config('app.test_uid', '00000000-0000-0000-0000-00000000a001', false)`);
      const aIds = (await client.query(
        `SELECT id FROM claims WHERE id IN ('claim_ct_1', 'claim_tb_1')`)).rows.map(r => r.id);
      if (!aIds.includes('claim_ct_1') || aIds.includes('claim_tb_1')) {
        throw new Error('tenant A should see only claim_ct_1: ' + JSON.stringify(aIds));
      }

      await client.query(`SELECT set_config('app.test_uid', '00000000-0000-0000-0000-0000000000b1', false)`);
      const bIds = (await client.query(
        `SELECT id FROM claims WHERE id IN ('claim_ct_1', 'claim_tb_1')`)).rows.map(r => r.id);
      if (!bIds.includes('claim_tb_1') || bIds.includes('claim_ct_1')) {
        throw new Error('tenant B should see only claim_tb_1: ' + JSON.stringify(bIds));
      }
    } finally {
      await client.query(`RESET ROLE`);
      await client.query(`DROP POLICY IF EXISTS tmp_ct_allow_all ON claims`);
    }
  });

  // ── Trust Foundation (Sprint 1) ────────────────────────────────────────────
  console.log('── Trust foundation: schema truth');

  const TENANT_A = '00000000-0000-0000-0000-000000000001';
  const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

  await check('ai_decisions accepts the aiDecisionsService (regulated audit) write shape', () =>
    client.query(
      `INSERT INTO ai_decisions (claim_id, decision_type, prompt_name, model, input_snapshot,
                                 output_parsed, output_raw, input_tokens, output_tokens,
                                 latency_ms, confidence, guardrail_actions, created_at)
       VALUES ('claim_ct_1', 'doc_classification', 'document_classification', 'claude-x',
               '{"mode":"text"}', '{"category":"medical"}', NULL, 10, 20, 300, 87.5,
               '[{"rule":"controlled_category_list","triggered":false}]', now())`));

  await check('ai_decisions accepts the M5-shape writers (award extraction / approvals)', () =>
    client.query(
      `INSERT INTO ai_decisions (claim_id, decision_type, model_used, system_prompt_hash,
                                 input_snapshot, output_raw, output_parsed, confidence,
                                 review_action, review_notes, reviewed_at)
       VALUES ('claim_ct_1', 'award_extraction', 'claude-x', repeat('a', 64),
               '{"pdfBytes":1}', '{}', '{}', 90, 'approved', 'ok', now())`));

  await check('ai_decisions links a human decision (linkHumanDecision columns)', () =>
    client.query(
      `UPDATE ai_decisions SET human_decision = 'accepted by adj@ct.test', human_decision_at = now()
        WHERE decision_type = 'doc_classification'`));

  await check('every public table has row-level security enabled (deny by default)', async () => {
    const { rows } = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY 1`);
    if (rows.length) throw new Error('RLS disabled on: ' + rows.map(r => r.relname).join(', '));
  });

  await check('users.active exists and defaults to TRUE', async () => {
    const { rows } = await client.query(
      `SELECT active FROM users WHERE id = '00000000-0000-0000-0000-00000000a001'`);
    if (!rows.length || rows[0].active !== true) throw new Error('users.active missing or not defaulted');
  });

  console.log('── Trust foundation: immutable audit ledger');

  const insertLedger = (tenant, action, extra = {}) => client.query(
    `INSERT INTO audit_ledger (tenant_id, actor_type, actor_id, actor_role, action,
                               entity_type, entity_id, claim_id, payload, evidence, seq, hash, prev_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 999, 'forged', 'forged')
     RETURNING id, seq, prev_hash, hash`,
    [tenant, extra.actor_type || 'human', extra.actor_id || 'adj@ct.test', extra.actor_role || 'adjuster',
     action, extra.entity_type || 'claim', extra.entity_id || 'claim_ct_1', extra.claim_id || 'claim_ct_1',
     JSON.stringify(extra.payload || {}), JSON.stringify(extra.evidence || [])]);

  let firstA;
  await check('the database assigns seq / prev_hash / hash (caller-supplied values are ignored)', async () => {
    firstA = (await insertLedger(TENANT_A, 'claim.status_changed', { payload: { from: 'new_claim', to: 'accepted' } })).rows[0];
    if (firstA.seq !== '1') throw new Error(`expected seq 1, got ${firstA.seq}`);
    if (firstA.prev_hash !== 'GENESIS') throw new Error(`expected GENESIS, got ${firstA.prev_hash}`);
    if (!/^[0-9a-f]{64}$/.test(firstA.hash)) throw new Error(`hash is not sha256 hex: ${firstA.hash}`);
  });

  await check('consecutive appends link into one chain', async () => {
    const second = (await insertLedger(TENANT_A, 'reserve.approved', {
      actor_type: 'human', payload: { medical_cents: 500000 },
      evidence: [{ type: 'action_request', id: 'ar_ct_1' }],
    })).rows[0];
    if (second.seq !== '2') throw new Error(`expected seq 2, got ${second.seq}`);
    if (second.prev_hash !== firstA.hash) throw new Error('prev_hash does not equal the predecessor hash');
  });

  await check('a multi-row insert chains every row in order', async () => {
    const { rows } = await client.query(
      `INSERT INTO audit_ledger (tenant_id, actor_type, action)
       VALUES ($1, 'agent', 'agent.recommendation_recorded'), ($1, 'system', 'notice.queued')
       RETURNING seq, prev_hash, hash`, [TENANT_A]);
    if (rows[0].seq !== '3' || rows[1].seq !== '4' || rows[1].prev_hash !== rows[0].hash) {
      throw new Error('multi-row chain broken: ' + JSON.stringify(rows));
    }
  });

  await expectError(client, 'UPDATE of a ledger row is rejected',
    `UPDATE audit_ledger SET payload = '{"tampered":true}' WHERE seq = 1`, /append-only/);
  await expectError(client, 'DELETE of a ledger row is rejected',
    `DELETE FROM audit_ledger WHERE seq = 1`, /append-only/);
  await expectError(client, 'TRUNCATE of the ledger is rejected',
    `TRUNCATE audit_ledger`, /append-only/);
  await expectError(client, 'unknown actor types are rejected',
    `INSERT INTO audit_ledger (tenant_id, actor_type, action) VALUES ('${TENANT_A}', 'robot', 'claim.viewed')`,
    /violates check constraint/);
  await expectError(client, 'malformed action names are rejected',
    `INSERT INTO audit_ledger (tenant_id, actor_type, action) VALUES ('${TENANT_A}', 'human', 'Delete Everything')`,
    /violates check constraint/);

  await check('verify() confirms an intact chain', async () => {
    const { rows } = await client.query(`SELECT * FROM app.audit_ledger_verify($1)`, [TENANT_A]);
    if (!rows[0].ok || rows[0].checked !== '4') throw new Error(JSON.stringify(rows[0]));
  });

  await check('the hash is independent of the session time zone', async () => {
    await client.query(`SET TIME ZONE 'America/Los_Angeles'`);
    try {
      const { rows } = await client.query(`SELECT * FROM app.audit_ledger_verify($1)`, [TENANT_A]);
      if (!rows[0].ok) throw new Error(JSON.stringify(rows[0]));
    } finally {
      await client.query(`SET TIME ZONE 'UTC'`);
    }
  });

  await check('each tenant has its own chain starting at GENESIS', async () => {
    const r = (await insertLedger(TENANT_B, 'claim.status_changed', { claim_id: 'claim_tb_1', entity_id: 'claim_tb_1' })).rows[0];
    if (r.seq !== '1' || r.prev_hash !== 'GENESIS') throw new Error(JSON.stringify(r));
  });

  await check('verify() detects an altered row (superuser bypass of the triggers)', async () => {
    await insertLedger(TENANT_B, 'payment.issued', { payload: { amount_cents: 100000 } });
    await insertLedger(TENANT_B, 'claim.closed');
    await client.query(`ALTER TABLE audit_ledger DISABLE TRIGGER audit_ledger_no_mutation`);
    try {
      await client.query(
        `UPDATE audit_ledger SET payload = '{"amount_cents": 1}' WHERE tenant_id = $1 AND seq = 2`, [TENANT_B]);
    } finally {
      await client.query(`ALTER TABLE audit_ledger ENABLE TRIGGER audit_ledger_no_mutation`);
    }
    const { rows } = await client.query(`SELECT * FROM app.audit_ledger_verify($1)`, [TENANT_B]);
    if (rows[0].ok || rows[0].first_bad_seq !== '2' || !/hash mismatch/.test(rows[0].reason)) {
      throw new Error('tampering not detected: ' + JSON.stringify(rows[0]));
    }
  });

  await check('verify() detects a removed row (sequence gap)', async () => {
    const C = '00000000-0000-0000-0000-0000000000c3';
    await client.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant C', 'tenant-c') ON CONFLICT DO NOTHING`, [C]);
    for (const a of ['claim.created', 'claim.status_changed', 'claim.closed']) await insertLedger(C, a);
    await client.query(`ALTER TABLE audit_ledger DISABLE TRIGGER audit_ledger_no_mutation`);
    try {
      await client.query(`DELETE FROM audit_ledger WHERE tenant_id = $1 AND seq = 2`, [C]);
    } finally {
      await client.query(`ALTER TABLE audit_ledger ENABLE TRIGGER audit_ledger_no_mutation`);
    }
    const { rows } = await client.query(`SELECT * FROM app.audit_ledger_verify($1)`, [C]);
    if (rows[0].ok || !/sequence gap/.test(rows[0].reason)) {
      throw new Error('removal not detected: ' + JSON.stringify(rows[0]));
    }
  });

  await check('head() returns the chain head for external anchoring', async () => {
    const { rows } = await client.query(`SELECT * FROM app.audit_ledger_head($1)`, [TENANT_A]);
    if (rows[0].seq !== '4' || !/^[0-9a-f]{64}$/.test(rows[0].hash)) throw new Error(JSON.stringify(rows[0]));
  });

  await check('ledger history is not tied to claim rows (no FK, no cascade)', async () => {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_ledger'::regclass
         AND contype = 'f' AND confrelid = 'claims'::regclass`);
    if (rows.length) throw new Error('audit_ledger must not reference claims');
  });

  await check('API roles cannot mutate the ledger (service_role: SELECT + INSERT only)', async () => {
    const { rows } = await client.query(
      `SELECT has_table_privilege('service_role', 'audit_ledger', 'INSERT') AS sr_insert,
              has_table_privilege('service_role', 'audit_ledger', 'UPDATE') AS sr_update,
              has_table_privilege('service_role', 'audit_ledger', 'DELETE') AS sr_delete,
              has_table_privilege('service_role', 'audit_ledger', 'TRUNCATE') AS sr_truncate,
              has_table_privilege('authenticated', 'audit_ledger', 'SELECT') AS auth_select,
              has_table_privilege('anon', 'audit_ledger', 'SELECT') AS anon_select`);
    const p = rows[0];
    if (!p.sr_insert || p.sr_update || p.sr_delete || p.sr_truncate || p.auth_select || p.anon_select) {
      throw new Error('unexpected privileges: ' + JSON.stringify(p));
    }
  });

  console.log('── Trust foundation: action requests');

  const arInsert = (id, extra = '') => `INSERT INTO action_requests
      (id, tenant_id, claim_id, action_type, proposed_by_type, proposed_by, proposal, policy_version ${extra ? ',' + extra.split('|')[0] : ''})
      VALUES ('${id}', '${TENANT_A}', 'claim_ct_1', 'reserve.change', 'agent', 'agent:reserve_analysis',
              '{"medical_cents":500000}', 'authority-default@1' ${extra ? ',' + extra.split('|')[1] : ''})`;

  await check('a pending agent proposal is accepted', () => client.query(arInsert('ar_ct_1')));

  await expectError(client, 'self-approval is rejected by the database',
    `UPDATE action_requests SET status = 'approved', decision = 'approve', decided_by = 'agent:reserve_analysis',
            decided_at = now(), decision_rationale = 'x' WHERE id = 'ar_ct_1'`,
    /action_requests_no_self_approval_chk/);

  await expectError(client, 'approval without a decision record is rejected',
    `UPDATE action_requests SET status = 'approved' WHERE id = 'ar_ct_1'`,
    /action_requests_execution_requires_approval_chk/);

  await expectError(client, 'rejection without a reject decision is rejected',
    `UPDATE action_requests SET status = 'rejected' WHERE id = 'ar_ct_1'`,
    /action_requests_rejected_requires_reject_chk/);

  await expectError(client, 'a decision without a rationale is rejected',
    `UPDATE action_requests SET status = 'approved', decision = 'approve', decided_by = 'sup@ct.test',
            decided_at = now() WHERE id = 'ar_ct_1'`,
    /action_requests_decided_fields_chk/);

  await expectError(client, 'a modify decision without the approved payload is rejected',
    `UPDATE action_requests SET status = 'approved', decision = 'modify', decided_by = 'sup@ct.test',
            decided_at = now(), decision_rationale = 'lowered' WHERE id = 'ar_ct_1'`,
    /action_requests_modify_payload_chk/);

  await check('a properly decided approval is accepted', () =>
    client.query(
      `UPDATE action_requests SET status = 'approved', decision = 'approve', decided_by = 'sup@ct.test',
              decided_by_role = 'supervisor', decided_at = now(), decision_rationale = 'Supported by worksheet'
        WHERE id = 'ar_ct_1'`));

  await check('idempotency keys are unique when present', async () => {
    await client.query(arInsert('ar_ct_2', `idempotency_key|'idem-ct-1'`));
    await client.query(arInsert('ar_ct_3'));   // NULL keys never collide
    try {
      await client.query(arInsert('ar_ct_4', `idempotency_key|'idem-ct-1'`));
    } catch (e) {
      if (/action_requests_idempotency_key_uq/.test(e.message)) return;
      throw e;
    }
    throw new Error('duplicate idempotency key accepted');
  });

  await check('a claim with approval history cannot be deleted out from under it', async () => {
    await client.query(
      `INSERT INTO claims (id, claim_number, status, date_of_injury) VALUES ('claim_ct_ar', 'HHW-2026-CAR', 'new_claim', '2026-05-03')`);
    await client.query(
      `INSERT INTO action_requests (id, tenant_id, claim_id, action_type, proposed_by_type, proposed_by, proposal, policy_version)
       VALUES ('ar_ct_fk', '${TENANT_A}', 'claim_ct_ar', 'reserve.change', 'human', 'adj@ct.test', '{}', 'authority-default@1')`);
    try {
      await client.query(`DELETE FROM claims WHERE id = 'claim_ct_ar'`);
    } catch (e) {
      if (/action_requests_claim_id_fkey/.test(e.message)) return;
      throw e;
    }
    throw new Error('claim with approval history was deleted');
  });

  await client.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
