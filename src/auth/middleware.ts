/**
 * Fastify auth middleware — verify session cookie, load tenant into request.
 *
 * Usage in handlers:
 *   app.get('/api/something', { preHandler: requireAuth }, async (req) => {
 *     req.tenant_id   // typed
 *     req.user_id
 *   });
 */
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { verifySession, type SessionPayload } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    user_id?: string;
    tenant_id?: string;
    role?: string;
    user_email?: string;
    is_admin?: boolean;
  }
}

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'fb_sid';
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

export function isAdminEmail(email: string | undefined | null): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

/** Hard gate: 403 if logged in but not in ADMIN_EMAILS. Must run after requireAuth or loadSession. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  if (!req.is_admin) return reply.status(403).send({ error: 'forbidden', message: 'Cần quyền admin' });
}

export async function loadSession(req: FastifyRequest): Promise<SessionPayload | null> {
  const sid = (req as any).cookies?.[COOKIE_NAME];
  if (!sid || typeof sid !== 'string') return null;
  try {
    return await verifySession(sid);
  } catch {
    return null;
  }
}

/** Hard gate: 401 if no/invalid session. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sess = await loadSession(req);
  if (!sess) return reply.status(401).send({ error: 'unauthorized', message: 'Cần đăng nhập' });
  req.user_id    = sess.sub;
  req.tenant_id  = sess.tid;
  req.role       = sess.role;
  req.user_email = sess.email;
}

/** Soft: loads session if present, never blocks. Use for endpoints that work logged-out (e.g. landing). */
export async function loadAuthOptional(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const sess = await loadSession(req);
  if (sess) {
    req.user_id    = sess.sub;
    req.tenant_id  = sess.tid;
    req.role       = sess.role;
    req.user_email = sess.email;
  }
}

export function requireRole(...allowed: string[]) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.role || !allowed.includes(req.role)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Không có quyền truy cập' });
    }
  };
}

// Cookie domain: when set (eg. ".autonow.vn"), the session cookie is shared across all
// subdomains (fb.autonow.vn ↔ dev-fb.autonow.vn ↔ dev-fb-vnc.autonow.vn). If unset,
// the cookie is bound to the exact request host (useful for localhost dev).
const COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN || undefined;

export function setSessionCookie(reply: FastifyReply, jwt: string): void {
  const ttlSeconds = Number(process.env.SESSION_TTL_HOURS ?? 12) * 3600;
  reply.setCookie(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, {
    path: '/',
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

/** Convenience: register @fastify/cookie + @fastify/rate-limit. */
export async function registerAuthPlugins(app: FastifyInstance): Promise<void> {
  const fastifyCookie = (await import('@fastify/cookie')).default;
  const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false, // only routes that opt in via config.rateLimit get limited
    max: 5,
    timeWindow: '1 minute',
    skipOnError: true,
  });
}
