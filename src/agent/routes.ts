/**
 * /api/agent/* — endpoints called by the customer-side agent.
 *
 * Auth: Bearer <license_key>. The global auth gate already authenticates and
 * sets req.tenant_id; requireAgent here is belt-and-braces for direct hits.
 *
 * Rate-limit: 10/min/IP per route (agent normally hits 1/min).
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireAgent } from './middleware.js';

const RL = { rateLimit: { max: 10, timeWindow: '1 minute' } } as const;

interface HeartbeatBody {
  agent_version?:    string;
  hostname?:         string;
  os?:               string;
  ram_mb?:           number;
  uptime_s?:         number;
  system_uptime_s?:  number;
  // Phase B3 UX: agent reports current state + executed-command status so
  // dashboard can show pills + know when to launch noVNC link.
  login_active?:      boolean;
  fb_session_alive?:  boolean;
  vnc_public_url?:    string;
  last_command?:      string;
  last_command_at?:   string;
  // v0.4+: live crawl state so dashboard can show "Đang crawl…" + disable buttons.
  run_in_flight?:     boolean;
  run_started_at?:    string;
  run_mode?:          string;
  run_label?:         string;
  run_groups_done?:   number;
  run_groups_total?:  number;
  run_current_group?: string;
  // FB profile of the account currently logged in chrome-profile (refreshed
  // weekly by agent from facebook.com/me og: tags).
  owner_name?:       string | null;
  owner_avatar_url?: string | null;
  // v0.5+: root filesystem disk usage on the agent VPS (powers disk alerts).
  disk_used_pct?:    number | null;
  disk_avail_gb?:    number | null;
  // v0.6+: agent's local watermark snapshot — mirrored to cloud DB so it
  // survives backup-restore / VPS migration. Cloud is authoritative on next
  // agent boot (GET /api/agent/watermarks during startup).
  watermarks?: Array<{
    entity:           string;
    scope:            string;
    last_cursor_time: string | null;
    last_run_at:      string | null;
    last_run_status?: string | null;
    last_run_count?:  number | null;
  }>;
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  // ---- HEARTBEAT ----
  app.post<{ Body: HeartbeatBody }>(
    '/api/agent/heartbeat',
    { preHandler: requireAgent, config: RL as any },
    async (req, reply) => {
      const tid = req.tenant_id!;
      const body = req.body ?? {};

      // Fingerprint enforcement: a license_key is locked to the first hostname
      // it heartbeats from. Stops customers from reusing one key on multiple
      // VPSes. Admin can reset via /api/admin/tenants/:id/reset-fingerprint
      // when the customer legitimately moves machines.
      const incomingHostname = typeof body.hostname === 'string' ? body.hostname.slice(0, 128) : null;
      if (incomingHostname) {
        const { rows: fp } = await pool.query(
          'SELECT hostname FROM agent_connections WHERE tenant_id = $1',
          [tid],
        );
        const lockedHostname = fp[0]?.hostname ?? null;
        if (lockedHostname && lockedHostname !== incomingHostname) {
          req.log.warn({ tid, lockedHostname, incomingHostname }, 'heartbeat rejected: hostname_locked');
          return reply.status(403).send({
            error:   'hostname_locked',
            message: 'This license key is already locked to another machine. Go to dashboard → Setup → Connection → "Reset VPS lock", or contact support.',
          });
        }
      }
      const metadata = {
        hostname:        typeof body.hostname === 'string' ? body.hostname.slice(0, 128) : null,
        os:              typeof body.os === 'string' ? body.os.slice(0, 128) : null,
        ram_mb:          Number.isFinite(body.ram_mb) ? body.ram_mb : null,
        uptime_s:        Number.isFinite(body.uptime_s) ? body.uptime_s : null,
        system_uptime_s: Number.isFinite(body.system_uptime_s) ? body.system_uptime_s : null,
        last_ip:         req.ip,
        last_command:    body.last_command ?? null,
        last_command_at: body.last_command_at ?? null,
        // Live crawl state (used by dashboard to show "Đang crawl…" + disable buttons)
        run_in_flight:    body.run_in_flight === true,
        run_started_at:   body.run_started_at ?? null,
        run_mode:         body.run_mode ?? null,
        run_label:        body.run_label ?? null,
        run_groups_done:  Number.isFinite(body.run_groups_done)  ? body.run_groups_done  : null,
        run_groups_total: Number.isFinite(body.run_groups_total) ? body.run_groups_total : null,
        run_current_group: body.run_current_group ?? null,
      };
      const loginActive    = body.login_active === true;
      const fbSessionAlive = body.fb_session_alive === true;
      const vncUrl         = typeof body.vnc_public_url === 'string' ? body.vnc_public_url.slice(0, 512) : null;
      const diskUsedPct    = typeof body.disk_used_pct === 'number' && Number.isFinite(body.disk_used_pct) ? Math.round(body.disk_used_pct) : null;
      const diskAvailGb    = typeof body.disk_avail_gb === 'number' && Number.isFinite(body.disk_avail_gb) ? body.disk_avail_gb : null;

      // UPSERT state.
      await pool.query(
        `INSERT INTO agent_connections
            (tenant_id, agent_version, connected_at, last_seen_at, status, metadata,
             login_active, fb_session_alive, vnc_public_url, disk_used_pct, disk_avail_gb, hostname)
         VALUES ($1, $2, now(), now(), 'online', $3::jsonb, $4, $5, COALESCE($6, ''), $7, $8, $9)
         ON CONFLICT (tenant_id) DO UPDATE SET
            agent_version    = EXCLUDED.agent_version,
            last_seen_at     = EXCLUDED.last_seen_at,
            status           = 'online',
            metadata         = EXCLUDED.metadata,
            login_active     = EXCLUDED.login_active,
            fb_session_alive = EXCLUDED.fb_session_alive,
            vnc_public_url   = CASE WHEN EXCLUDED.vnc_public_url <> '' THEN EXCLUDED.vnc_public_url ELSE agent_connections.vnc_public_url END,
            disk_used_pct    = COALESCE(EXCLUDED.disk_used_pct, agent_connections.disk_used_pct),
            disk_avail_gb    = COALESCE(EXCLUDED.disk_avail_gb, agent_connections.disk_avail_gb),
            hostname         = COALESCE(agent_connections.hostname, EXCLUDED.hostname)`,
        [tid, body.agent_version ?? null, JSON.stringify(metadata), loginActive, fbSessionAlive, vncUrl, diskUsedPct, diskAvailGb, incomingHostname]
      );
      // Persist agent-reported FB owner name + avatar into tenant_settings.config
      // so the Dashboard's session card shows them. We only update fields the
      // user hasn't explicitly overridden (write-once unless agent has a new
      // value AND user's value is empty).
      if (body.owner_name || body.owner_avatar_url) {
        await pool.query(
          `INSERT INTO tenant_settings (tenant_id, config)
           VALUES ($1, jsonb_strip_nulls(jsonb_build_object('fb_display_name', $2::text, 'fb_avatar_url', $3::text)))
           ON CONFLICT (tenant_id) DO UPDATE
             SET config = tenant_settings.config
               || jsonb_strip_nulls(jsonb_build_object(
                    'fb_display_name', CASE WHEN tenant_settings.config ? 'fb_display_name' THEN NULL ELSE $2::text END,
                    'fb_avatar_url',   CASE WHEN tenant_settings.config ? 'fb_avatar_url'   THEN NULL ELSE $3::text END))`,
          [tid, body.owner_name ?? null, body.owner_avatar_url ?? null]
        );
      }
      // Pop the oldest pending command from the FIFO queue. Multiple clicks
      // from dashboard now queue separately — agent gets one per heartbeat.
      const { rows: popRows } = await pool.query(
        `UPDATE agent_commands
            SET consumed_at = now(), result = 'sent'
          WHERE id = (
            SELECT id FROM agent_commands
              WHERE tenant_id = $1 AND consumed_at IS NULL
              ORDER BY issued_at LIMIT 1
              FOR UPDATE SKIP LOCKED
          )
          RETURNING cmd, payload`,
        [tid]
      );
      const pendingCommand = popRows[0]?.cmd ?? null;
      const pendingPayload = popRows[0]?.payload ?? null;

      // Mirror agent's watermarks into etl_watermark (cloud-side persist).
      // Cloud writes use GREATEST() to never go backward — same semantics as
      // local writeWatermark. So even if agent re-sends an older value (after
      // restore from backup), cloud preserves the latest known good cursor.
      if (Array.isArray(body.watermarks) && body.watermarks.length) {
        for (const w of body.watermarks) {
          if (typeof w?.entity !== 'string' || typeof w?.scope !== 'string') continue;
          if (!w.last_cursor_time) continue;
          await pool.query(
            `INSERT INTO etl_watermark
                (tenant_id, entity, scope, last_cursor_time, last_run_at,
                 last_run_status, last_run_count)
             VALUES ($1, $2, $3, $4::timestamptz, COALESCE($5::timestamptz, now()), $6, $7)
             ON CONFLICT (tenant_id, entity, scope) DO UPDATE SET
                last_cursor_time = GREATEST(EXCLUDED.last_cursor_time, etl_watermark.last_cursor_time),
                last_run_at      = EXCLUDED.last_run_at,
                last_run_status  = EXCLUDED.last_run_status,
                last_run_count   = EXCLUDED.last_run_count`,
            [tid, w.entity.slice(0, 64), w.scope.slice(0, 128),
             w.last_cursor_time, w.last_run_at,
             w.last_run_status ?? null, Number.isFinite(w.last_run_count) ? w.last_run_count : null],
          ).catch((e) => req.log.warn({ err: e?.message }, 'watermark upsert failed'));
        }
      }

      return {
        ok:              true,
        tenant_id:       tid,
        server_time:     new Date().toISOString(),
        config:          { heartbeat_interval_sec: 60 },
        // If dashboard issued a command since last HB, deliver it once here.
        command:         pendingCommand,
        command_payload: pendingPayload,
      };
    }
  );

  // ---- WATERMARK BOOTSTRAP ----
  // Agent calls this once on startup to seed local state.json from cloud's
  // authoritative copy. Survives backup-restore / VPS migration.
  app.get('/api/agent/watermarks', { preHandler: requireAgent, config: RL as any }, async (req) => {
    const tid = req.tenant_id!;
    const { rows } = await pool.query(
      `SELECT entity, scope, last_cursor_time, last_run_at, last_run_status, last_run_count
         FROM etl_watermark WHERE tenant_id = $1`,
      [tid],
    );
    return { ok: true, tenant_id: tid, watermarks: rows };
  });

  // ---- ACTION RESULT CALLBACK ----
  // Agent reports outcome of post_to_group / comment_on_post commands.
  app.post<{ Body: { action_type?: 'post' | 'reply'; action_id?: number; status?: string; fb_id?: string | null; error?: string | null } }>(
    '/api/agent/action-result',
    { preHandler: requireAgent, config: RL as any },
    async (req, reply) => {
      const tid = req.tenant_id!;
      const b = req.body ?? {};
      if (!b.action_type || !b.action_id || !b.status) {
        return reply.status(400).send({ error: 'missing fields' });
      }
      const isPosted = b.status === 'posted' || b.status === 'pending_review';
      const isSent = b.status === 'commented' || b.status === 'submitted';
      if (b.action_type === 'post') {
        await pool.query(
          `UPDATE fb_post_queue
              SET status = $1,
                  attempts = attempts + 1,
                  posted_fb_id = COALESCE($2, posted_fb_id),
                  error = $3,
                  posted_at = CASE WHEN $4 THEN NOW() ELSE posted_at END
            WHERE id = $5 AND tenant_id = $6`,
          [b.status, b.fb_id ?? null, b.error ?? null, isPosted, b.action_id, tid],
        );
      } else if (b.action_type === 'reply') {
        await pool.query(
          `UPDATE fb_reply_queue
              SET status = $1,
                  attempts = attempts + 1,
                  posted_fb_id = COALESCE($2, posted_fb_id),
                  error = $3,
                  sent_at = CASE WHEN $4 THEN NOW() ELSE sent_at END
            WHERE id = $5 AND tenant_id = $6`,
          [b.status, b.fb_id ?? null, b.error ?? null, isSent, b.action_id, tid],
        );
      }
      // Fire-and-forget: notify the Telegram bot card (edit in-place) so user
      // sees the result without polling. Only does anything if the queue row
      // has bot_chat_id (i.e. originated from telegram).
      void import('../telegram/reply_notify.js').then(async ({ notifyPostResult, notifyReplyResult }) => {
        const fbUrl = b.fb_id ? `https://www.facebook.com/${b.fb_id}` : null;
        if (b.action_type === 'post') {
          const s = (b.status === 'posted' || b.status === 'pending_review' || b.status === 'rate_limited') ? b.status : 'failed';
          await notifyPostResult(tid, b.action_id!, s as any, fbUrl, b.error ?? null);
        } else if (b.action_type === 'reply') {
          const s = (b.status === 'commented' || b.status === 'submitted')
            ? 'sent'
            : (b.status === 'rate_limited' ? 'rate_limited' : 'failed');
          await notifyReplyResult(tid, b.action_id!, s as any, fbUrl, b.error ?? null);
        }
      }).catch((e) => console.warn(`[tg-notify] action-result push failed: ${e?.message ?? e}`));
      return { ok: true };
    },
  );
}
