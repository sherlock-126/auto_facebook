-- Weekly comment-analysis snapshots, grouped by category (hr / fulfill / other).
-- Each row = one (tenant, week, category) snapshot computed by the analyzer cron.
CREATE TABLE IF NOT EXISTS comment_insights (
  id              SERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  week_start      DATE NOT NULL,                  -- Monday of the analyzed week
  category        TEXT NOT NULL,                  -- 'hr' | 'fulfill' | 'other'
  total_comments  INT  NOT NULL DEFAULT 0,
  top_commenters  JSONB NOT NULL DEFAULT '[]'::jsonb,
  hot_threads     JSONB NOT NULL DEFAULT '[]'::jsonb,
  gemini_summary  TEXT,                           -- markdown summary of themes
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, week_start, category)
);
CREATE INDEX IF NOT EXISTS idx_comment_insights_tenant_week
  ON comment_insights (tenant_id, week_start DESC);
