-- Telegram bot interface: multi-turn conversation state + reply queue link to
-- the chat message so we can edit/confirm in-place after agent action completes.

-- Transient state per (tenant, chat). Drops after TTL or on /cancel.
CREATE TABLE IF NOT EXISTS fb_bot_state (
  tenant_id   TEXT        NOT NULL,
  chat_id     TEXT        NOT NULL,         -- Telegram chat.id as string (negative for groups)
  user_id     BIGINT,                       -- last interacting user (for audit)
  state_name  TEXT        NOT NULL,         -- 'compose_pick_variant' | 'compose_pick_group' | 'reply_edit_text'
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + interval '30 minutes'),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_fb_bot_state_expires ON fb_bot_state (expires_at);

-- Link reply rows back to their Telegram card so we can edit-in-place after
-- agent posts ("✓ Đã gửi: <permalink>") instead of sending a fresh message.
ALTER TABLE fb_reply_queue ADD COLUMN IF NOT EXISTS bot_chat_id    TEXT;
ALTER TABLE fb_reply_queue ADD COLUMN IF NOT EXISTS bot_message_id BIGINT;

ALTER TABLE fb_post_queue  ADD COLUMN IF NOT EXISTS bot_chat_id    TEXT;
ALTER TABLE fb_post_queue  ADD COLUMN IF NOT EXISTS bot_message_id BIGINT;
