-- 007_agent_command_queue.sql
-- Replaces the single pending_command column with a proper FIFO queue table.
-- Fixes the "click twice → first command lost" bug (UPDATE overwrites previous).
--
-- Old single column kept for backwards-compat during rollout (drop later).

CREATE TABLE IF NOT EXISTS agent_commands (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  cmd          TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by    TEXT,                -- user_email of admin/owner who clicked
  consumed_at  TIMESTAMPTZ,
  result       TEXT                 -- 'ok' | 'error' | 'skipped'
);

-- Partial index = only unprocessed commands. Cheap to scan even with months of history.
CREATE INDEX IF NOT EXISTS idx_agent_commands_pending
  ON agent_commands (tenant_id, issued_at)
  WHERE consumed_at IS NULL;

-- Cleanup old completed commands periodically — leave for cron job (later).
