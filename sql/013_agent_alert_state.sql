-- Track agent health-state transitions + latest disk usage.
-- src/ops/agent_alerts.ts reads/writes last_status* to decide when to fire
-- Telegram alerts (transition-based, no spam). Disk fields populated from
-- the agent heartbeat.

ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS last_status      TEXT,
  ADD COLUMN IF NOT EXISTS last_status_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disk_used_pct    INTEGER,
  ADD COLUMN IF NOT EXISTS disk_avail_gb    NUMERIC;
