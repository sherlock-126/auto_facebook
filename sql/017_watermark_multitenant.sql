-- Mirror agent's local state.json watermark to cloud DB. Survives:
--   - Backup-restore (agent state.json reverts → boot fetches latest from cloud)
--   - VPS migration (new VPS → first boot picks up cloud watermark)
--   - Operator intervention (admin can reset cursor via SQL)
--
-- Made tenant-scoped so 1000+ tenants can each track their own watermarks
-- without collision on the (entity, scope) tuple.

ALTER TABLE etl_watermark ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tu-n';
ALTER TABLE etl_watermark ALTER COLUMN tenant_id DROP DEFAULT;

ALTER TABLE etl_watermark DROP CONSTRAINT etl_watermark_pkey;
ALTER TABLE etl_watermark ADD CONSTRAINT etl_watermark_pkey PRIMARY KEY (tenant_id, entity, scope);

CREATE INDEX IF NOT EXISTS idx_etl_watermark_tenant ON etl_watermark (tenant_id, last_run_at DESC);
