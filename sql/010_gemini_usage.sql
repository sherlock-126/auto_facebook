-- Token usage + cost tracking for every Gemini API call.
-- Filled by src/leads/gemini_usage.ts:logGeminiUsage() from response.usageMetadata.

CREATE TABLE IF NOT EXISTS gemini_usage (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model           TEXT        NOT NULL,
  purpose         TEXT        NOT NULL,        -- 'classifier:enum' | 'classifier:rules' | 'comment_analyzer:hr' | ...
  prompt_tokens   INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  cached_tokens   INTEGER     NOT NULL DEFAULT 0,
  thinking_tokens INTEGER     NOT NULL DEFAULT 0,
  total_tokens    INTEGER     NOT NULL DEFAULT 0,
  ok              BOOLEAN     NOT NULL DEFAULT TRUE,
  err             TEXT
);

CREATE INDEX IF NOT EXISTS idx_gemini_usage_tenant_called
  ON gemini_usage (tenant_id, called_at DESC);
