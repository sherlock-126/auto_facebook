-- agent_commands.payload: queued command parameters (e.g. nav_url, post body).
-- The column existed on older DBs out-of-band but was never captured as a migration,
-- so fresh deploys (e.g. nextclaw prod) lacked it → agent heartbeat 500 on the
-- command pop (RETURNING cmd, payload). Idempotent so it's safe to (re)apply.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS payload JSONB;
