-- ============================================================
-- auto_facebook migration 002: Lead pipeline + multi-tenant prep
-- See docs/PLAN_LEADS.md for full design.
-- Idempotent via IF NOT EXISTS / DO NOTHING.
-- ============================================================

-- 1. tenant_id on every dim/fact table (default 'default' for single-tenant)
ALTER TABLE dim_group               ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE dim_user                ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE fact_group_post         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE fact_group_post_comment ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_dim_group_tenant   ON dim_group       (tenant_id);
CREATE INDEX IF NOT EXISTS idx_fact_post_tenant   ON fact_group_post (tenant_id, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_fact_cmt_tenant    ON fact_group_post_comment (tenant_id, created_time DESC);

-- 2. Per-tenant config (driver of classifier behaviour)
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id   TEXT PRIMARY KEY,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO tenant_settings (tenant_id, config) VALUES (
  'default',
  '{
    "lead_intents":      ["request_quote","question","complaint"],
    "classifier_enabled": true,
    "classifier_model":   "gemini-2.5-flash"
  }'::jsonb
) ON CONFLICT (tenant_id) DO NOTHING;

-- 3. Classifier cache — same message in many groups = one Gemini call
CREATE TABLE IF NOT EXISTS lead_classifier_cache (
  msg_hash    TEXT PRIMARY KEY,
  intent      TEXT,
  confidence  NUMERIC,
  reason      TEXT,
  entities    JSONB,
  model       TEXT,
  cached_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Lead pipeline (1 row per post that warranted a lead)
CREATE TABLE IF NOT EXISTS fact_lead (
  lead_id              BIGSERIAL PRIMARY KEY,
  tenant_id            TEXT NOT NULL DEFAULT 'default',
  post_id              TEXT NOT NULL REFERENCES fact_group_post(post_id) ON DELETE CASCADE,
  group_id             TEXT REFERENCES dim_group(group_id),
  author_id            TEXT,

  intent               TEXT,
  intent_confidence    NUMERIC,
  intent_reason        TEXT,
  intent_entities      JSONB,
  classified_at        TIMESTAMPTZ,

  stage                TEXT NOT NULL DEFAULT 'new',
  stage_changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_to          TEXT,
  note                 TEXT,

  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (post_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_tenant_stage   ON fact_lead (tenant_id, stage, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_intent         ON fact_lead (intent, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_unclassified   ON fact_lead (classified_at) WHERE classified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_group          ON fact_lead (group_id, detected_at DESC);

-- 5. Activity log per lead
CREATE TABLE IF NOT EXISTS lead_history (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES fact_lead(lead_id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  from_value  TEXT,
  to_value    TEXT,
  note        TEXT,
  actor       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history (lead_id, created_at DESC);
