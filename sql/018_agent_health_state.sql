-- Per-tenant health-check transition state. Each key tracks the last alerted
-- state of one detector (session, disk, etc.). Cron in agent_alerts.ts diffs
-- current vs stored state and sends Telegram on transition — same pattern as
-- the heartbeat staleness check (last_status).
--
-- Example value:
--   {"session": "healthy", "disk": "full"}
--
-- Extensible without further migrations — add new detectors by writing new
-- keys.

ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS health_state JSONB NOT NULL DEFAULT '{}'::jsonb;
