-- FB sale-flow actions: compose posts to groups + AI-suggested replies that
-- customer manually approves. Both queue tables are tenant-scoped.

-- Queue for outgoing posts customer composes in dashboard.
CREATE TABLE IF NOT EXISTS fb_post_queue (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT        NOT NULL,
  group_id      TEXT        NOT NULL,
  content       TEXT        NOT NULL,
  image_urls    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  schedule_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT        NOT NULL DEFAULT 'pending',
                -- pending | dispatched | posted | rate_limited | pending_review | failed | cancelled
  attempts      INT         NOT NULL DEFAULT 0,
  posted_fb_id  TEXT,
  error         TEXT,
  posted_at     TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fb_post_queue_due
  ON fb_post_queue (tenant_id, status, schedule_at);

-- Queue for AI-suggested replies awaiting customer approval.
CREATE TABLE IF NOT EXISTS fb_reply_queue (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  lead_id         BIGINT      REFERENCES fact_lead(lead_id) ON DELETE CASCADE,
  post_id         TEXT        NOT NULL,
  post_permalink  TEXT,
  suggested_text  TEXT        NOT NULL,
  final_text      TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending_review',
                  -- pending_review | approved | sent | rate_limited | failed | skipped
  attempts        INT         NOT NULL DEFAULT 0,
  posted_fb_id    TEXT,
  error           TEXT,
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fb_reply_queue_pending
  ON fb_reply_queue (tenant_id, status, created_at DESC);
