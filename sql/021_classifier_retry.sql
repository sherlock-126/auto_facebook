-- Backoff window for posts whose classifier call recently failed (Gemini 503
-- "high demand" spike etc). Detector skips re-processing for 1h after a failed
-- attempt to stop burning quota on the same post crawl-after-crawl.

ALTER TABLE fact_group_post ADD COLUMN IF NOT EXISTS classifier_failed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_fact_group_post_classifier_failed_at
  ON fact_group_post (classifier_failed_at)
  WHERE classifier_failed_at IS NOT NULL;
