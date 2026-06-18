-- License key fingerprint: lock 1 tenant to 1 hostname (write-once).
-- Prevents the same license_key from being reused on multiple VPSes.
-- Admin can clear hostname via /api/admin/tenants/:id/reset-fingerprint when a
-- customer legitimately moves to a new VPS.

ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS hostname TEXT;

-- Backfill from JSONB metadata for any rows that already have it stashed there.
UPDATE agent_connections
   SET hostname = metadata->>'hostname'
 WHERE hostname IS NULL
   AND metadata ? 'hostname'
   AND length(metadata->>'hostname') > 0;
