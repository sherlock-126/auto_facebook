/**
 * JWT session + single-use email tokens.
 */
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-insecure-please-set-JWT_SECRET');
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 12);

export interface SessionPayload {
  sub: string;        // user_id
  tid: string;        // tenant_id
  role: string;
  email: string;
}

export async function signSession(p: SessionPayload): Promise<string> {
  return await new SignJWT({ ...p })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.sub)
    .setIssuedAt()
    .setExpirationTime(`${TTL_HOURS}h`)
    .sign(SECRET);
}

export async function verifySession(jwt: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(jwt, SECRET);
  return payload as unknown as SessionPayload;
}

/** Cryptographically-random URL-safe token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export type TokenPurpose = 'verify_email' | 'reset_password';

const TTL_MS: Record<TokenPurpose, number> = {
  verify_email:   24 * 60 * 60_000,   // 24 hours
  reset_password:  1 * 60 * 60_000,   // 1 hour
};

export async function issueToken(userId: string, purpose: TokenPurpose): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + TTL_MS[purpose]);
  await pool.query(
    'INSERT INTO auth_tokens (token, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [token, userId, purpose, expiresAt]
  );
  return token;
}

export interface ConsumeResult {
  ok: boolean;
  user_id?: string;
  reason?: 'not_found' | 'expired' | 'used';
}

/** Atomic: validate + mark used in one UPDATE. */
export async function consumeToken(token: string, purpose: TokenPurpose): Promise<ConsumeResult> {
  const { rows } = await pool.query(
    `UPDATE auth_tokens
        SET used_at = now()
      WHERE token = $1 AND purpose = $2
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [token, purpose]
  );
  if (rows[0]) return { ok: true, user_id: rows[0].user_id };

  // Diagnose why it failed
  const { rows: diag } = await pool.query(
    'SELECT used_at, expires_at FROM auth_tokens WHERE token = $1 AND purpose = $2',
    [token, purpose]
  );
  if (!diag[0]) return { ok: false, reason: 'not_found' };
  if (diag[0].used_at)               return { ok: false, reason: 'used' };
  if (diag[0].expires_at <= new Date()) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'not_found' };
}
