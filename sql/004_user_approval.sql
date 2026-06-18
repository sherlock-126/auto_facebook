-- 004_user_approval.sql
-- Adds an admin-approval gate between email verification and login.
-- Workflow: signup → verify email → wait for admin approval → admin approves → welcome email → can log in.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by  TEXT;          -- email of admin who approved

-- Backfill: existing users (i.e. tuantran the admin) are already trusted.
UPDATE users
   SET approved_at = COALESCE(approved_at, now()),
       approved_by = COALESCE(approved_by, 'system:bootstrap')
 WHERE approved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_pending ON users (created_at DESC) WHERE approved_at IS NULL;
