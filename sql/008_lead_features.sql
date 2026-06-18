-- 008_lead_features.sql
-- Phase C: sales workflow upgrades.
--
-- 1. is_anonymous_post on fact_group_post — agent parses from FB raw and
--    cloud stores so kanban + lead detail can show 🎭 badge + recommend
--    "comment publicly" instead of "IB" for anonymous authors.
-- 2. Telegram + notification preferences live inside tenant_settings.config
--    (JSONB) — no new columns needed. Just document the expected keys:
--      telegram_bot_token: string (BotFather token, "12345:ABC-...")
--      telegram_chat_id:   string ("123456789" personal, "-100..." group)
--      notify_intents:     string[] (subset of INTENT_VALUES)

ALTER TABLE fact_group_post
  ADD COLUMN IF NOT EXISTS is_anonymous_post BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for "anonymous-only" filter in Kanban (small subset → cheap).
CREATE INDEX IF NOT EXISTS idx_fact_post_anonymous
  ON fact_group_post (tenant_id, created_time DESC)
  WHERE is_anonymous_post;
