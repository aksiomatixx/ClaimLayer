-- M6 Retrofit — additive schema changes only

-- employees: SSDI receiving flag (LC §4661.5 TD offset + MSA screening at settlement)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS
  ssdi_receiving BOOLEAN DEFAULT FALSE;

-- claims: employer_contests (populated by employer acknowledgment form in future milestone)
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
  employer_contests BOOLEAN DEFAULT FALSE;

-- claims: motor vehicle AOE/COE intake responses
-- { driving_between_patients: bool|null, other_vehicle_involved: bool|null, police_responded: bool|null }
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
  motor_vehicle_fields JSONB;

-- claims: subrogation tracking
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
  subrogation_status VARCHAR(30) DEFAULT 'not_applicable'
  CHECK (subrogation_status IN (
    'not_applicable', 'under_evaluation', 'waived', 'referred', 'recovered'
  ));

-- claims: add future_medical_only to valid status set
ALTER TABLE claims DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE claims ADD CONSTRAINT valid_status CHECK (status IN (
  'new_claim', 'intake_complete', 'under_investigation', 'accepted',
  'active_medical', 'p_and_s', 'pd_evaluation', 'settlement_discussions',
  'future_medical_only', 'closed', 'denied', 'litigated'
));

-- documents: extended indexing fields (M8 document processing pipeline will populate these)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS confidence SMALLINT;
  -- 0-100 AI extraction confidence; docs with confidence < 85 go to review queue in M8
ALTER TABLE documents ADD COLUMN IF NOT EXISTS category VARCHAR(30);
  -- controlled list: medical | bill | legal | qme | state_form | rfa | pharmacy |
  --                  correspondence | surveillance | wage | other
  -- docs with category = 'other' go to review queue in M8
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title VARCHAR(300);
  -- AI generated document title
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type VARCHAR(30);
  -- treating_physician | specialist | employer | worker | legal | pharmacy | other
ALTER TABLE documents ADD COLUMN IF NOT EXISTS dos_range_start DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS dos_range_end DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS dos_is_range BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_documents_confidence ON documents(confidence)
  WHERE confidence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)
  WHERE category IS NOT NULL;

-- automation_config: key-value store for automation level settings (M9 will seed this)
CREATE TABLE IF NOT EXISTS automation_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         VARCHAR(100) UNIQUE NOT NULL,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- supplemental_requests: QME/PR-4 supplemental report tracking (M11 will use this)
CREATE TABLE IF NOT EXISTS supplemental_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id             VARCHAR(60) REFERENCES claims(id),
  document_id          UUID REFERENCES documents(id),
  flags                JSONB NOT NULL,
  draft_text           TEXT,
  status               VARCHAR(30) DEFAULT 'draft'
                       CHECK (status IN ('draft', 'adjuster_review', 'sent', 'dismissed')),
  reviewed_by          UUID REFERENCES users(id),
  reviewed_at          TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  response_due         DATE,
  response_received_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplemental_claim  ON supplemental_requests(claim_id);
CREATE INDEX IF NOT EXISTS idx_supplemental_status ON supplemental_requests(status)
  WHERE status IN ('draft', 'adjuster_review');

ALTER TABLE automation_config     ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplemental_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_config_admin ON automation_config
  FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) = 'admin');

CREATE POLICY supplemental_requests_admin ON supplemental_requests
  FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
