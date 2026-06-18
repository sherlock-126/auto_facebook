-- Org-name extraction for lead dedup + customer-curated blocklist.
-- See: project_lead_dedup memory + 7/6 user report about HUTATO/PRINTUZ/VELORA spam.

-- Org name stored both raw (for display) and normalized (for matching).
ALTER TABLE fact_lead ADD COLUMN IF NOT EXISTS org_name      TEXT;
ALTER TABLE fact_lead ADD COLUMN IF NOT EXISTS org_name_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_fact_lead_org_dedup
  ON fact_lead (tenant_id, org_name_norm, detected_at DESC)
  WHERE org_name_norm IS NOT NULL;

-- Customer-curated blocklist. scope='org' matches normalized company name
-- extracted by Gemini; scope='author' matches FB author_id directly.
CREATE TABLE IF NOT EXISTS lead_blocklist (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  scope        TEXT        NOT NULL DEFAULT 'org',
  pattern      TEXT        NOT NULL,
  display_name TEXT,
  created_by   TEXT,
  created_via  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, scope, pattern)
);
CREATE INDEX IF NOT EXISTS idx_blocklist_tenant ON lead_blocklist (tenant_id, scope);

-- Prompt schema changed (now asks for org_name) → cached verdicts are stale.
-- Wipe once so next classify call hits fresh Gemini with new schema.
DELETE FROM lead_classifier_cache;
