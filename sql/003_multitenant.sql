-- ============================================================
-- auto_facebook migration 003: multi-tenant SaaS foundation
-- See docs/PLAN_SAAS.md for full design.
-- Idempotent via IF NOT EXISTS / DO NOTHING.
-- ============================================================

-- 1. Tenants — 1 customer = 1 tenant
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id     TEXT PRIMARY KEY,                    -- slug, eg 'acme-corp'
  name          TEXT NOT NULL,
  owner_email   TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',        -- free | pro | enterprise
  license_key   TEXT NOT NULL UNIQUE,                -- agent uses this to connect WSS
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- merged with tenant_settings (legacy)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenants_owner_email ON tenants (owner_email);

-- 2. Users — auth subjects. Multiple users per tenant supported.
CREATE TABLE IF NOT EXISTS users (
  user_id              TEXT PRIMARY KEY,                                -- uuid (gen_random_uuid())
  tenant_id            TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,                                   -- bcrypt cost 12, ~60 chars
  email_verified_at    TIMESTAMPTZ,
  role                 TEXT NOT NULL DEFAULT 'owner',                   -- owner | admin | member
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (lower(email));

-- 3. Single-use email tokens (verification + password reset)
CREATE TABLE IF NOT EXISTS auth_tokens (
  token       TEXT PRIMARY KEY,                               -- 32-byte hex, sha256-hashed at rest? for MVP store raw
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,                                  -- 'verify_email' | 'reset_password'
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_unused ON auth_tokens (purpose, expires_at) WHERE used_at IS NULL;

-- 4. Agent connection state (Phase B uses this, Phase A just creates the table)
CREATE TABLE IF NOT EXISTS agent_connections (
  tenant_id       TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  agent_version   TEXT,
  connected_at    TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'offline',           -- offline | online | stale | error
  metadata        JSONB                                      -- {os, ram_mb, fb_session_alive, ...}
);

-- 5. Audit log — cross-tenant access attempts, sensitive ops
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT,
  user_id       TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  metadata      JSONB,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_log (action, created_at DESC);

-- 6. Bootstrap 'default' tenant (existing data) if not exists, then will be renamed
INSERT INTO tenants (tenant_id, name, owner_email, plan, license_key)
VALUES (
  'default',
  'Built-in default',
  'admin@autonow.vn',
  'enterprise',
  'INTERNAL-' || md5(random()::text || clock_timestamp()::text)
)
ON CONFLICT (tenant_id) DO NOTHING;

-- 7. Backfill: link existing tenant_settings → tenants.config (one-time)
UPDATE tenants t
   SET config = ts.config
  FROM tenant_settings ts
 WHERE t.tenant_id = ts.tenant_id
   AND t.config = '{}'::jsonb;

-- 8. RLS — enable on all multi-tenant fact/dim tables
-- Connections without `SET LOCAL app.tenant_id` see NOTHING (current_setting returns NULL).
-- Admin/migration scripts run as superuser (BYPASSRLS).

DO $$
BEGIN
  -- dim_group
  ALTER TABLE dim_group ENABLE ROW LEVEL SECURITY;
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON dim_group';
  EXECUTE 'CREATE POLICY tenant_isolation ON dim_group USING (tenant_id = current_setting(''app.tenant_id'', true))';

  ALTER TABLE dim_user ENABLE ROW LEVEL SECURITY;
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON dim_user';
  EXECUTE 'CREATE POLICY tenant_isolation ON dim_user USING (tenant_id = current_setting(''app.tenant_id'', true))';

  ALTER TABLE fact_group_post ENABLE ROW LEVEL SECURITY;
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON fact_group_post';
  EXECUTE 'CREATE POLICY tenant_isolation ON fact_group_post USING (tenant_id = current_setting(''app.tenant_id'', true))';

  ALTER TABLE fact_group_post_comment ENABLE ROW LEVEL SECURITY;
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON fact_group_post_comment';
  EXECUTE 'CREATE POLICY tenant_isolation ON fact_group_post_comment USING (tenant_id = current_setting(''app.tenant_id'', true))';

  ALTER TABLE fact_lead ENABLE ROW LEVEL SECURITY;
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON fact_lead';
  EXECUTE 'CREATE POLICY tenant_isolation ON fact_lead USING (tenant_id = current_setting(''app.tenant_id'', true))';

  -- BYPASSRLS for fb_etl (the application role). The app sets app.tenant_id per request.
  -- Without BYPASSRLS, queries without SET LOCAL would silently return 0 rows — better
  -- to fail fast in dev. But for our deployment we trust the middleware to always set it,
  -- and rely on RLS for double-protection only.
  -- ALTER ROLE fb_etl BYPASSRLS;   -- DO NOT enable: defeats RLS purpose
END $$;

-- 9. Helper view: tenant overview (for admin dashboards later)
CREATE OR REPLACE VIEW v_tenant_overview AS
SELECT
  t.tenant_id,
  t.name,
  t.owner_email,
  t.plan,
  t.created_at,
  t.suspended_at,
  (SELECT count(*) FROM users WHERE tenant_id = t.tenant_id) AS user_count,
  (SELECT status FROM agent_connections WHERE tenant_id = t.tenant_id) AS agent_status,
  (SELECT last_seen_at FROM agent_connections WHERE tenant_id = t.tenant_id) AS agent_last_seen
FROM tenants t;
