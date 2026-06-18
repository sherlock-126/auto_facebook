-- 005_etl_run_tenant.sql
-- Adds tenant_id to etl_run so cloud + each agent can have separate run logs.
-- Cloud's legacy ETL (running for tuantran) keeps its rows tagged 'tuantran'.
-- Agents upload run summaries that get tagged with the agent's tenant_id
-- (resolved from license_key in /api/agent/upload).

ALTER TABLE etl_run
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tuantran';

CREATE INDEX IF NOT EXISTS idx_etl_run_tenant_started
  ON etl_run (tenant_id, started_at DESC);
