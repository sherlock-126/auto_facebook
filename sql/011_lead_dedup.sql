-- Content-based lead de-duplication.
-- Recruiters re-post identical job ads many times (same author, same text,
-- different post_id + created_time). Each repost previously became a new lead
-- and a new Telegram alert. We now fingerprint normalized content and skip
-- leads whose (tenant_id, author_id, content_hash) was already seen recently.

ALTER TABLE fact_lead ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_lead_dedup
  ON fact_lead (tenant_id, author_id, content_hash, detected_at DESC);

-- Backfill existing leads. Normalization MUST match detector.ts:hashContent()
-- (trim → collapse whitespace runs → lowercase).
UPDATE fact_lead l
   SET content_hash = md5(lower(regexp_replace(btrim(p.message), '\s+', ' ', 'g')))
  FROM fact_group_post p
 WHERE p.post_id = l.post_id
   AND l.content_hash IS NULL
   AND p.message IS NOT NULL
   AND btrim(p.message) <> '';
