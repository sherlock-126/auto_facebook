-- ============================================================
-- auto_facebook initial schema
-- Pattern: borrowed from adg_database (MISA), adapted for FB groups.
-- Scope: groups the logged-in user has joined.
-- ============================================================

-- ------------------------------------------------------------
-- Session storage (after manual noVNC login)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fb_session (
  id            SERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  storage_state JSONB NOT NULL,
  c_user        TEXT,                    -- extracted from cookies for quick lookup
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_fb_session_active ON fb_session (is_active, created_at DESC);

-- ------------------------------------------------------------
-- Short-lived auth context cache (fb_dtsg etc. captured per browser session)
-- These tokens rotate; re-capture if call returns 1357004 (Invalid form data).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fb_auth_context (
  id            SERIAL PRIMARY KEY,
  session_id    INT NOT NULL REFERENCES fb_session(id) ON DELETE CASCADE,
  fb_dtsg       TEXT NOT NULL,
  lsd           TEXT,
  jazoest       TEXT,
  spin_r        TEXT,
  spin_t        TEXT,
  hsi           TEXT,
  rev           TEXT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw           JSONB
);
CREATE INDEX IF NOT EXISTS idx_fb_auth_context_session ON fb_auth_context (session_id, captured_at DESC);

-- ------------------------------------------------------------
-- Dimension: group (auto-populated from fb_joined_groups entity)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_group (
  group_id      TEXT PRIMARY KEY,        -- FB group fbid (numeric)
  name          TEXT,
  url           TEXT,                    -- canonical permalink
  privacy       TEXT,                    -- 'OPEN' | 'CLOSED' | 'SECRET' (FB enum)
  member_count  BIGINT,
  is_joined     BOOLEAN NOT NULL DEFAULT TRUE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,  -- user toggle: scrape this group?
  raw           JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dim_group_enabled ON dim_group (enabled, is_joined);

-- ------------------------------------------------------------
-- Dimension: user (posters, commenters)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_user (
  user_id       TEXT PRIMARY KEY,
  username      TEXT,
  name          TEXT,
  avatar_url    TEXT,
  raw           JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Fact: post inside a group
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_group_post (
  post_id           TEXT PRIMARY KEY,    -- FB story/post fbid
  group_id          TEXT NOT NULL REFERENCES dim_group(group_id),
  author_id         TEXT,
  permalink         TEXT,
  message           TEXT,
  story_type        TEXT,                -- 'text', 'photo', 'video', 'link', 'shared', etc.
  created_time      TIMESTAMPTZ,
  attachment_url    TEXT,
  reaction_count    INT,
  comment_count     INT,
  share_count       INT,
  raw               JSONB,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fact_group_post_group_time ON fact_group_post (group_id, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_fact_group_post_created ON fact_group_post (created_time DESC);

-- ------------------------------------------------------------
-- Fact: comment on a group post
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_group_post_comment (
  comment_id        TEXT PRIMARY KEY,
  post_id           TEXT NOT NULL REFERENCES fact_group_post(post_id) ON DELETE CASCADE,
  parent_comment_id TEXT,
  author_id         TEXT,
  message           TEXT,
  created_time      TIMESTAMPTZ,
  reaction_count    INT,
  raw               JSONB,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fact_group_post_comment_post ON fact_group_post_comment (post_id, created_time DESC);

-- ------------------------------------------------------------
-- ETL watermark (per entity, per scope = group_id)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_watermark (
  entity           TEXT NOT NULL,
  scope            TEXT NOT NULL,        -- group_id or 'global'
  last_cursor_time TIMESTAMPTZ,
  last_run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_status  TEXT,
  last_run_count   INT,
  last_error       TEXT,
  PRIMARY KEY (entity, scope)
);

-- ------------------------------------------------------------
-- ETL audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_run (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,           -- e.g. 'fb_group_post:incr'
  scope         TEXT,                    -- group_id
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running',  -- running | ok | error | aborted
  rows_total    INT,
  rows_upserted INT,
  message       TEXT,
  params        JSONB
);
CREATE INDEX IF NOT EXISTS idx_etl_run_started ON etl_run (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_etl_run_kind_status ON etl_run (kind, status);

-- ------------------------------------------------------------
-- XHR capture buffer — central to "discover mode"
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xhr_capture (
  id                 BIGSERIAL PRIMARY KEY,
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id         INT REFERENCES fb_session(id) ON DELETE SET NULL,
  discover_run_id    TEXT,                       -- label of a discover session
  method             TEXT,
  url                TEXT,
  friendly_name      TEXT,                       -- x-fb-friendly-name header / fb_api_req_friendly_name body field
  doc_id             TEXT,                       -- GraphQL doc_id if present
  status             INT,
  request_headers    JSONB,
  request_body       TEXT,
  response_body      TEXT,
  note               TEXT
);
CREATE INDEX IF NOT EXISTS idx_xhr_capture_time ON xhr_capture (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_xhr_capture_friendly ON xhr_capture (friendly_name);
CREATE INDEX IF NOT EXISTS idx_xhr_capture_discover ON xhr_capture (discover_run_id, captured_at DESC);

-- ------------------------------------------------------------
-- Daily request budget counter (per account, per day)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fb_request_budget (
  c_user        TEXT NOT NULL,
  day           DATE NOT NULL,
  count         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (c_user, day)
);
