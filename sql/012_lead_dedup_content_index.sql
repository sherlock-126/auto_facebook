-- Supports the content-only de-dup query (long posts, author ignored) in
-- detector.ts. The 011 index leads with author_id so it can't serve a
-- content_hash-only lookup efficiently.

CREATE INDEX IF NOT EXISTS idx_lead_dedup_content
  ON fact_lead (tenant_id, content_hash, detected_at DESC);
