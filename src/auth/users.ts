/**
 * User + tenant provisioning. One signup = one user + one tenant.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { hashPassword } from './passwords.js';

export interface CreatedUser {
  user_id: string;
  tenant_id: string;
  email: string;
  license_key: string;
}

function slugify(name: string): string {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'tenant';
}

async function uniqueTenantSlug(baseSlug: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    const { rows } = await pool.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [slug]);
    if (rows.length === 0) return slug;
  }
  // Fallback random
  return `${baseSlug}-${randomBytes(3).toString('hex')}`;
}

export async function findUserByEmail(email: string) {
  const { rows } = await pool.query(
    `SELECT user_id, tenant_id, email, password_hash, email_verified_at, approved_at, role
       FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
}

export async function approveUser(userId: string, approvedBy: string): Promise<void> {
  await pool.query(
    `UPDATE users SET approved_at = now(), approved_by = $2 WHERE user_id = $1 AND approved_at IS NULL`,
    [userId, approvedBy]
  );
}

export async function revokeApproval(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users SET approved_at = NULL, approved_by = NULL WHERE user_id = $1`,
    [userId]
  );
}

export async function createUserAndTenant(args: {
  email: string;
  password: string;
  tenant_name?: string;
  plan?: string;
}): Promise<CreatedUser> {
  const email = args.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');

  const existing = await findUserByEmail(email);
  if (existing) throw new Error('That email is already registered');

  const hash = await hashPassword(args.password);
  const tenantName = (args.tenant_name?.trim() || email.split('@')[0]).slice(0, 80);
  const baseSlug = slugify(tenantName);
  const tenantId = await uniqueTenantSlug(baseSlug);
  const licenseKey = `lk_${randomBytes(24).toString('base64url')}`;
  const userId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ALLOWED_PLANS = new Set(['free', 'starter', 'pro', 'scale', 'enterprise']);
    const plan = ALLOWED_PLANS.has(String(args.plan)) ? String(args.plan) : 'free';
    await client.query(
      `INSERT INTO tenants (tenant_id, name, owner_email, plan, license_key, config)
       VALUES ($1, $2, $3, $5, $4,
               '{"lead_intents":["request_quote","question","complaint"],"classifier_enabled":true,"classifier_model":"gemini-2.5-flash"}'::jsonb)`,
      [tenantId, tenantName, email, licenseKey, plan]
    );
    await client.query(
      `INSERT INTO users (user_id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [userId, tenantId, email, hash]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { user_id: userId, tenant_id: tenantId, email, license_key: licenseKey };
}

export async function markEmailVerified(userId: string): Promise<void> {
  await pool.query(
    'UPDATE users SET email_verified_at = now() WHERE user_id = $1 AND email_verified_at IS NULL',
    [userId]
  );
}

export async function updatePassword(userId: string, newHash: string): Promise<void> {
  await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [newHash, userId]);
}

export async function recordLogin(userId: string): Promise<void> {
  await pool.query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [userId]);
}
