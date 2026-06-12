-- ════════════════════════════════════════════════════════════════════════════
-- Supervisor Daily Alerts (CL-SUP1)
--
-- One digest row per supervisor per day: important diaries due today
-- (CRITICAL or no_snooze) and every open overdue diary, grouped by
-- adjuster then claim, snapshotted as JSON. Generation is idempotent —
-- the UNIQUE (alert_date, recipient_user_id) pair makes a re-run for
-- the same date an update, never a duplicate. Deterministic queries
-- only; no model involvement anywhere in this feature.
--
-- DEPLOYMENT ORDER: apply before deploying the supervisor-alert
-- backend (migrate → deploy, always).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS supervisor_alerts (
  id                 TEXT PRIMARY KEY,
  alert_date         DATE NOT NULL,
  recipient_user_id  TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}',
  due_today_count    INTEGER NOT NULL DEFAULT 0,
  overdue_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at    TIMESTAMPTZ,
  acknowledged_by    TEXT,
  CONSTRAINT supervisor_alerts_counts_chk
    CHECK (due_today_count >= 0 AND overdue_count >= 0),
  CONSTRAINT supervisor_alerts_recipient_date_uq
    UNIQUE (alert_date, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS supervisor_alerts_recipient_idx
  ON supervisor_alerts (recipient_user_id, alert_date);

COMMIT;
