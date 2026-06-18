/**
 * Agent auth: `Authorization: Bearer <license_key>` → resolve to tenant_id.
 *
 * Used as a preHandler on /api/agent/*. Also invoked directly from the global
 * auth gate so we can bypass session auth for agent traffic.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db.js';

declare module 'fastify' {
  interface FastifyRequest {
    is_agent?: boolean;
    agent_license_key?: string;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolves the Bearer license_key to a tenant. Returns true if the request was
 * authenticated as an agent (request mutated), false otherwise. Does NOT send
 * a response on failure — caller decides what to do.
 */
export async function tryAuthAgent(req: FastifyRequest): Promise<boolean> {
  const key = extractBearer(req);
  if (!key || !key.startsWith('lk_')) return false;
  const { rows } = await pool.query(
    'SELECT tenant_id FROM tenants WHERE license_key = $1',
    [key]
  );
  if (!rows[0]) return false;
  req.tenant_id        = rows[0].tenant_id;
  req.is_agent         = true;
  req.agent_license_key = key;
  return true;
}

/**
 * Hard gate: 401 if no valid Bearer license_key. Used as a per-route preHandler
 * on agent endpoints when the global auth gate didn't already authenticate.
 */
export async function requireAgent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.is_agent) return;
  const ok = await tryAuthAgent(req);
  if (!ok) {
    return reply.status(401).send({ error: 'invalid_license', message: 'Invalid license key' });
  }
}
