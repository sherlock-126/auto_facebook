-- 006_agent_commands.sql
-- Adds per-tenant pending command + login/session state to agent_connections so
-- the customer dashboard can drive the customer-VPS agent without SSH:
--   - dashboard sets pending_command ('open_login' | 'close_login' | 'discover_now')
--   - agent reads on next heartbeat, executes, clears
--   - dashboard polls login_active / fb_session_alive to know when to show noVNC link

ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS pending_command    TEXT,
  ADD COLUMN IF NOT EXISTS command_issued_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS login_active       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fb_session_alive   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vnc_public_url     TEXT;

-- vnc_public_url stores http://<public-ip>:6092/vnc.html?...&password=...
-- Agent reports this on heartbeat (it knows its own public IP + password).
-- Cloud serves it to dashboard so the "Open Facebook" button can launch noVNC.
