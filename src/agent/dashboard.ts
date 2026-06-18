/**
 * Dashboard-side endpoints for controlling the customer's agent.
 *
 * Auth: session cookie (regular user, tenant-scoped). Mounts:
 *   POST /api/dashboard/agent/command  { cmd }   — queue a command for next HB
 *   GET  /api/dashboard/agent/status              — current agent state (poll every 3s)
 *
 * Commands ('open_login' | 'close_login' | 'discover_now') are stored in
 * agent_connections.pending_command and popped atomically when agent posts
 * its next heartbeat (see src/agent/routes.ts).
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { statusOf } from './status.js';

type Command = 'open_login' | 'close_login' | 'discover_now' | 'discover_groups_only' | 'refresh_owner_profile' | 'crawl_now_incr' | 'post_to_group' | 'comment_on_post';
const VALID_CMDS: Set<Command> = new Set(['open_login', 'close_login', 'discover_now', 'discover_groups_only', 'refresh_owner_profile', 'crawl_now_incr', 'post_to_group', 'comment_on_post']);

export async function registerAgentDashboardRoutes(app: FastifyInstance): Promise<void> {
  // ---- ISSUE COMMAND ----
  // FIFO queue (agent_commands table). Multiple clicks queue separately —
  // agent pops one per heartbeat in issued_at order.
  app.post<{ Body: { cmd?: string; nav_url?: string | null } }>('/api/dashboard/agent/command', async (req, reply) => {
    if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
    const cmd = req.body?.cmd as Command;
    if (!VALID_CMDS.has(cmd)) {
      return reply.status(400).send({ error: 'invalid_cmd', allowed: Array.from(VALID_CMDS) });
    }
    const tid = req.tenant_id!;
    // Make sure agent exists for this tenant
    const { rows } = await pool.query(
      'SELECT 1 FROM agent_connections WHERE tenant_id = $1',
      [tid]
    );
    if (!rows[0]) {
      return reply.status(404).send({ error: 'no_agent', message: 'Agent not installed on your VPS' });
    }
    const payload = req.body?.nav_url ? { nav_url: req.body.nav_url.slice(0, 500) } : null;
    await pool.query(
      `INSERT INTO agent_commands (tenant_id, cmd, issued_by, payload) VALUES ($1, $2, $3, $4)`,
      [tid, cmd, req.user_email ?? null, payload ? JSON.stringify(payload) : null]
    );
    const { rows: pending } = await pool.query(
      `SELECT count(*)::int AS n FROM agent_commands WHERE tenant_id = $1 AND consumed_at IS NULL`,
      [tid]
    );
    return {
      ok:      true,
      cmd,
      queued:  pending[0].n,
      message: `Command queued (${pending[0].n} chờ thực hiện); agent xử lý mỗi 60s (heartbeat tick)`,
    };
  });

  // ---- GET STATUS ----
  app.get('/api/dashboard/agent/status', async (req, reply) => {
    if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
    const tid = req.tenant_id!;
    const { rows } = await pool.query(
      `SELECT agent_version, last_seen_at, login_active, fb_session_alive, vnc_public_url, metadata
         FROM agent_connections WHERE tenant_id = $1`,
      [tid]
    );
    if (!rows[0]) {
      return { ok: true, installed: false };
    }
    const r = rows[0];
    const { rows: q } = await pool.query(
      `SELECT cmd, issued_at FROM agent_commands
         WHERE tenant_id = $1 AND consumed_at IS NULL
         ORDER BY issued_at LIMIT 10`,
      [tid]
    );
    return {
      ok:                true,
      installed:         true,
      agent_version:     r.agent_version,
      last_seen_at:      r.last_seen_at,
      online_status:     statusOf(r.last_seen_at),
      login_active:      r.login_active,
      fb_session_alive:  r.fb_session_alive,
      vnc_public_url:    r.vnc_public_url || null,
      pending_commands:  q,
      pending_count:     q.length,
      last_command:      r.metadata?.last_command ?? null,
      last_command_at:   r.metadata?.last_command_at ?? null,
      // Live crawl state
      run_in_flight:     r.metadata?.run_in_flight === true,
      run_started_at:    r.metadata?.run_started_at ?? null,
      run_mode:          r.metadata?.run_mode ?? null,
      run_label:         r.metadata?.run_label ?? null,
      run_groups_done:   r.metadata?.run_groups_done ?? null,
      run_groups_total:  r.metadata?.run_groups_total ?? null,
      run_current_group: r.metadata?.run_current_group ?? null,
    };
  });
}
