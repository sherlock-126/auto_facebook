/**
 * Fastify server: dashboard + login helper + discover mode + admin actions.
 *
 * Login helper opens headed Chrome on Xvfb so the user can drive it through
 * noVNC (embedded as iframe). Discover mode opens another browser with the
 * saved session and logs every FB API XHR to xhr_capture.
 */
import 'dotenv/config';
import Fastify from 'fastify';
import type { Page } from 'playwright';
import { pool } from './db.js';
import { saveSession } from './fb/session.js';
import { runOne, runAll } from './etl/runner.js';
import { startDiscover, stopDiscover, listCaptureSummary, getCapture, getDiscoverHandle } from './fb/discover.js';
import { getBrowserContext, closeBrowserContext } from './fb/browser.js';
import { maybeCreateLead } from './leads/detector.js';
import { STAGE_VALUES, STAGE_LABELS, INTENT_VALUES, INTENT_LABELS, getTenantConfig, patchTenantConfig, type Stage, type Intent, type TenantConfig } from './leads/pipeline.js';
import { runCommentInsights, runWeeklyInsightsAllTenants } from './insights/comment_analyzer.js';
import { getFunnel, getDailyStats, getVelocity, getHeatmap } from './leads/stats.js';
import { registerAuthPlugins, loadSession, isAdminEmail } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAuthPages } from './auth/pages.js';
import { renderLanding } from './landing.js';
import { registerAdmin } from './admin.js';
import { registerAgentRoutes } from './agent/routes.js';
import { registerAgentUploadRoutes } from './agent/upload.js';
import { registerAgentDashboardRoutes } from './agent/dashboard.js';
import { tryAuthAgent } from './agent/middleware.js';
import { statusOf } from './agent/status.js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const PORT = Number(process.env.APP_PORT ?? 4200);
const HOST = process.env.APP_HOST ?? '0.0.0.0';
const NOVNC_BASE = process.env.NOVNC_PUBLIC_URL ?? `http://127.0.0.1:${process.env.NOVNC_WEB_PORT ?? 6091}`;
const VNC_PASSWORD = process.env.VNC_PASSWORD ?? '';
const NOVNC_URL = `${NOVNC_BASE}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(VNC_PASSWORD)}`;

const app = Fastify({ logger: true });

// ----- login (manual via noVNC, on the shared persistent context) -----
let loginPage: Page | null = null;

app.post('/api/login/start', async () => {
  if (loginPage) return { ok: true, note: 'login session already open' };
  const ctx = await getBrowserContext();
  loginPage = await ctx.newPage();
  await loginPage.goto('https://www.facebook.com/login');
  return { ok: true, note: 'Browser opened on shared profile — connect via noVNC to login' };
});

app.post('/api/login/save', async () => {
  const ctx = await getBrowserContext();
  // Either explicit /api/login/start ran (loginPage set) or the user already
  // browsed via the persistent profile and just wants to snapshot cookies.
  const meta = await saveSession(ctx);
  try { await loginPage?.close(); } catch {}
  loginPage = null;
  return { ok: true, ...meta };
});

app.post('/api/login/cancel', async () => {
  try { await loginPage?.close(); } catch {}
  loginPage = null;
  return { ok: true };
});

app.get('/api/login/state', async () => ({
  loginOpen: !!loginPage,
}));

// ----- discover mode -----
app.post<{ Body?: { startUrl?: string; label?: string } | null }>('/api/discover/start', async (req) => {
  return await startDiscover(req.body ?? {});
});
app.post('/api/discover/stop', async () => {
  return await stopDiscover();
});
app.get<{ Querystring: { runId?: string } }>('/api/discover/captures', async (req) => {
  const rows = await listCaptureSummary(req.query.runId);
  const handle = getDiscoverHandle();
  return { runId: handle?.runId ?? null, running: !!handle, rows };
});
app.get<{ Params: { id: string } }>('/api/discover/captures/:id', async (req) => {
  const row = await getCapture(Number(req.params.id));
  if (!row) return { ok: false };
  return { ok: true, row };
});

// ----- groups -----
app.get<{ Querystring: { q?: string; enabled?: 'on' | 'off' | 'all'; limit?: string; offset?: string } }>('/api/groups', async (req) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const where: string[] = ['tenant_id = $1'];
  const params: unknown[] = [req.tenant_id!];
  if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`name ILIKE $${params.length}`); }
  if (req.query.enabled === 'on')  where.push('enabled = TRUE');
  if (req.query.enabled === 'off') where.push('enabled = FALSE');
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled_total
       FROM dim_group ${whereSql}`,
    params
  );
  const { rows: globalRows } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled_total FROM dim_group WHERE tenant_id = $1`,
    [req.tenant_id!]
  );
  params.push(limit); params.push(offset);
  const { rows } = await pool.query(
    `SELECT group_id, name, url, privacy, member_count, is_joined, enabled, first_seen_at, updated_at
       FROM dim_group ${whereSql}
      ORDER BY enabled DESC, name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    rows,
    paging: { limit, offset, total: countRows[0].total, enabled_in_filter: countRows[0].enabled_total },
    totals: { total: globalRows[0].total, enabled: globalRows[0].enabled_total },
  };
});
app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/groups/:id', async (req) => {
  if (typeof req.body.enabled === 'boolean') {
    await pool.query(
      'UPDATE dim_group SET enabled = $1, updated_at = now() WHERE group_id = $2 AND tenant_id = $3',
      [req.body.enabled, req.params.id, req.tenant_id!]
    );
  }
  return { ok: true };
});

/**
 * Manually add a group user has joined that FB's all_joined_groups API didn't
 * return (cache lag, private groups, pending-membership, etc). Accepts either
 * a raw numeric ID or a full FB URL — we extract the id with a regex.
 */
app.post<{ Body: { url?: string; name?: string; enabled?: boolean } }>('/api/groups', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const raw = (req.body?.url ?? '').trim();
  if (!raw) return reply.status(400).send({ ok: false, error: 'missing url' });
  // Extract group id: accept full URL (groups/<id>/) or just digits
  const m = raw.match(/groups\/(\d{6,})/) ?? raw.match(/^(\d{6,})$/);
  if (!m) return reply.status(400).send({ ok: false, error: 'Không parse được group ID. Paste full URL https://www.facebook.com/groups/<id>/ hoặc chỉ ID số.' });
  const groupId = m[1];
  const url     = `https://www.facebook.com/groups/${groupId}/`;
  const enabled = req.body?.enabled !== false; // default ON since user explicitly added
  const tid     = req.tenant_id!;

  // Insert if new; preserve existing enabled if user has set it.
  const { rows: existing } = await pool.query(
    `SELECT enabled FROM dim_group WHERE group_id=$1 AND tenant_id=$2`,
    [groupId, tid]
  );
  if (existing[0]) {
    await pool.query(
      `UPDATE dim_group SET is_joined=TRUE, enabled=$1, name=COALESCE($2, name), url=COALESCE($3, url), updated_at=now()
        WHERE group_id=$4 AND tenant_id=$5`,
      [enabled, req.body.name ?? null, url, groupId, tid]
    );
    return { ok: true, group_id: groupId, message: 'Group đã có sẵn — đã update + enable.' };
  }
  await pool.query(
    `INSERT INTO dim_group (group_id, tenant_id, name, url, is_joined, enabled, raw, first_seen_at)
     VALUES ($1, $2, $3, $4, TRUE, $5, '{}'::jsonb, now())`,
    [groupId, tid, req.body.name ?? `Group ${groupId}`, url, enabled]
  );
  return { ok: true, group_id: groupId, message: 'Đã thêm group. Cron */30 phút kế tiếp sẽ crawl.' };
});

// ----- ad-hoc run -----
app.post<{ Body: { entity: string; scope: string; mode?: 'incr' | 'full' } }>('/api/run', async (req) => {
  const { entity, scope, mode } = req.body;
  return await runOne(entity, scope, mode ?? 'incr');
});

// ----- scheduler trigger (called by scheduler.ts via HTTP, fire-and-forget) -----
// runAll across 160 groups × 2 entities can legitimately take 1-3 hours, so
// the handler returns immediately; the actual work runs in the background and
// rows land in etl_run as entities complete. An in-memory flag + PG advisory
// lock serialize overlapping triggers.
const RUN_ALL_LOCK_KEY = 0x46420000;
let runAllInFlight: Promise<unknown> | null = null;
let runAllStartedAt: Date | null = null;
// Self-serve: customer can clear the agent fingerprint lock for their tenant.
// Used when they migrate VPS or rename hostname. Refuses if agent is currently
// online (the lock is useful) — they must stop the agent first if they really
// want to reset while it's up.
app.post('/api/agent/reset-fingerprint', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const tid = req.tenant_id!;
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS sec_ago, hostname
       FROM agent_connections WHERE tenant_id = $1`,
    [tid],
  );
  if (!rows[0]) return { ok: false, error: 'no_agent_connection' };
  // If the heartbeat is fresh (<5 min) we likely won't help by resetting —
  // and resetting opens a small window where any incoming hostname is accepted.
  if (rows[0].sec_ago < 300) {
    return reply.status(409).send({
      error: 'agent_still_online',
      message: `Agent vẫn đang gửi heartbeat (${rows[0].sec_ago}s trước). Dừng agent trên VPS cũ trước khi reset.`,
    });
  }
  await pool.query('UPDATE agent_connections SET hostname = NULL WHERE tenant_id = $1', [tid]);
  return { ok: true, previous_hostname: rows[0].hostname };
});

// Ops: agent health check — triggered by scheduler every ~5 min. Looks at
// agent_connections last_seen_at + last_status, sends Telegram on transitions.
app.post('/api/ops/check-agent-health', async (req) => {
  if (req.role !== 'system') return { ok: false, error: 'forbidden' };
  const { checkAgentHealth } = await import('./ops/agent_alerts.js');
  const r = await checkAgentHealth();
  return { ok: true, ...r };
});

app.post<{ Body?: { mode?: 'incr' | 'full' } }>('/api/run/all', async (req, reply) => {
  const mode = req.body?.mode ?? 'incr';
  const tid = req.tenant_id;
  if (!tid) return reply.status(400).send({ error: 'tenant_id required' });
  if (runAllInFlight) {
    return { ok: false, skipped: true, reason: 'another runAll already in progress', startedAt: runAllStartedAt };
  }
  const lock = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [RUN_ALL_LOCK_KEY]);
  if (lock.rows[0].locked !== true) {
    return { ok: false, skipped: true, reason: 'pg advisory lock held' };
  }
  runAllStartedAt = new Date();
  runAllInFlight = (async () => {
    try {
      const r = await runAll(mode, tid);
      app.log.info({ summary: { ok: r.ok, results: r.results.length, errors: r.errors.length } }, `runAll(${mode}) finished`);
      return r;
    } catch (e: any) {
      app.log.error({ err: e?.message ?? String(e) }, `runAll(${mode}) failed`);
      throw e;
    } finally {
      await pool.query('SELECT pg_advisory_unlock($1)', [RUN_ALL_LOCK_KEY]).catch(() => {});
      runAllInFlight = null;
      runAllStartedAt = null;
    }
  })();
  // Surface promise rejections to the logger; don't crash the process.
  runAllInFlight.catch(() => {});
  return { ok: true, started: true, mode, startedAt: runAllStartedAt };
});

app.get('/api/run/all/state', async () => ({
  running: !!runAllInFlight,
  startedAt: runAllStartedAt,
}));

// ─── Sale-flow: compose posts + AI-suggested replies ──────────────────────

// Compose new outgoing post (text + optional image_urls + schedule).
app.post<{ Body: { group_id?: string; content?: string; image_urls?: string[]; schedule_at?: string } }>(
  '/api/posts/compose', async (req, reply) => {
    if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
    const tid = req.tenant_id!;
    const b = req.body ?? {};
    if (!b.group_id || !b.content || b.content.trim().length === 0) {
      return reply.status(400).send({ error: 'missing group_id or content' });
    }
    const scheduleAt = b.schedule_at ? new Date(b.schedule_at) : new Date();
    if (Number.isNaN(scheduleAt.getTime())) return reply.status(400).send({ error: 'invalid schedule_at' });
    const images = Array.isArray(b.image_urls) ? b.image_urls.filter((u) => typeof u === 'string').slice(0, 5) : [];
    const { rows } = await pool.query(
      `INSERT INTO fb_post_queue (tenant_id, group_id, content, image_urls, schedule_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id, status, schedule_at`,
      [tid, b.group_id, b.content.trim(), JSON.stringify(images), scheduleAt, req.user_email ?? null],
    );
    return { ok: true, post: rows[0] };
  },
);

app.get<{ Querystring: { limit?: string; status?: string } }>('/api/posts/queue', async (req) => {
  const tid = req.tenant_id!;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const params: any[] = [tid];
  let where = 'tenant_id = $1';
  if (req.query.status) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, group_id, content, image_urls, schedule_at, status, attempts,
            posted_fb_id, error, posted_at, created_by, created_at,
            (SELECT name FROM dim_group WHERE group_id = fb_post_queue.group_id AND tenant_id = $1 LIMIT 1) AS group_name
       FROM fb_post_queue WHERE ${where}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return { rows };
});

app.delete<{ Params: { id: string } }>('/api/posts/queue/:id', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const tid = req.tenant_id!;
  const { rowCount } = await pool.query(
    `UPDATE fb_post_queue SET status='cancelled' WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','dispatched')`,
    [req.params.id, tid],
  );
  return { ok: (rowCount ?? 0) > 0 };
});

// Pending replies queue (manual approve flow).
app.get('/api/replies/queue', async (req) => {
  const tid = req.tenant_id!;
  const { rows } = await pool.query(
    `SELECT q.id, q.lead_id, q.post_id, q.post_permalink, q.suggested_text, q.final_text,
            q.status, q.error, q.created_at, q.sent_at, q.approved_at,
            l.intent, l.intent_confidence,
            p.message AS post_message, p.created_time AS post_created_time,
            p.raw->'actors'->0->>'name' AS author_name,
            g.name AS group_name, g.group_id AS group_id
       FROM fb_reply_queue q
       LEFT JOIN fact_lead       l ON l.lead_id = q.lead_id
       LEFT JOIN fact_group_post p ON p.post_id = q.post_id AND p.tenant_id = q.tenant_id
       LEFT JOIN dim_group       g ON g.group_id = p.group_id AND g.tenant_id = q.tenant_id
      WHERE q.tenant_id = $1 AND q.status IN ('pending_review','approved','sent','rate_limited','failed')
      ORDER BY q.created_at DESC LIMIT 100`,
    [tid],
  );
  return { rows };
});

app.post<{ Params: { id: string }; Body?: { final_text?: string } }>(
  '/api/replies/queue/:id/approve', async (req, reply) => {
    if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
    const tid = req.tenant_id!;
    const text = (req.body?.final_text ?? '').trim();
    const { rows } = await pool.query(
      `UPDATE fb_reply_queue
          SET status='approved',
              approved_at = NOW(),
              approved_by = $3,
              final_text = COALESCE(NULLIF($4,''), suggested_text)
        WHERE id=$1 AND tenant_id=$2 AND status='pending_review'
       RETURNING id, post_permalink, COALESCE(final_text, suggested_text) AS body`,
      [req.params.id, tid, req.user_email ?? null, text || ''],
    );
    if (!rows[0]) return reply.status(404).send({ error: 'not_found_or_not_pending' });
    if (!rows[0].post_permalink) {
      await pool.query(`UPDATE fb_reply_queue SET status='failed', error='no_post_permalink' WHERE id=$1`, [req.params.id]);
      return reply.status(400).send({ error: 'no_post_permalink' });
    }
    // Queue agent command for the comment.
    await pool.query(
      `INSERT INTO agent_commands (tenant_id, cmd, payload)
       VALUES ($1, 'comment_on_post', $2::jsonb)`,
      [tid, JSON.stringify({ action_id: rows[0].id, post_url: rows[0].post_permalink, content: rows[0].body })],
    );
    return { ok: true };
  },
);

app.delete<{ Params: { id: string } }>('/api/replies/queue/:id', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const tid = req.tenant_id!;
  const { rowCount } = await pool.query(
    `UPDATE fb_reply_queue SET status='skipped' WHERE id=$1 AND tenant_id=$2 AND status='pending_review'`,
    [req.params.id, tid],
  );
  return { ok: (rowCount ?? 0) > 0 };
});

// ─── lead blocklist (org-name + author-id suppression) ──────────────────────
app.get('/api/blocklist', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const { rows } = await pool.query(
    `SELECT id, scope, pattern, display_name, created_by, created_via, created_at
       FROM lead_blocklist WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [req.tenant_id!],
  );
  return { rows };
});

app.post<{ Body: { scope?: string; pattern?: string; display_name?: string; lead_id?: number } }>(
  '/api/blocklist', async (req, reply) => {
    if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
    const tid = req.tenant_id!;
    // If lead_id is provided, use the reusable blockOrgFromLead helper (also
    // auto-archives sibling open leads).
    if (req.body?.lead_id) {
      const { blockOrgFromLead } = await import('./leads/blocklist.js');
      const r = await blockOrgFromLead(tid, Number(req.body.lead_id), req.user_email ?? 'dashboard', 'dashboard');
      if (!r.ok) return reply.status(400).send({ ok: false, error: r.error });
      return { ok: true, archived: r.archived, org_name: r.org_name, already_blocked: r.already_blocked };
    }
    // Manual add (no lead context) — just insert.
    const scope = (req.body?.scope === 'author') ? 'author' : 'org';
    const patternRaw = (req.body?.pattern ?? '').trim();
    if (!patternRaw) return reply.status(400).send({ error: 'pattern required' });
    let pattern = patternRaw;
    if (scope === 'org') {
      const { normalizeOrgName } = await import('./leads/blocklist.js');
      const norm = normalizeOrgName(patternRaw);
      if (!norm) return reply.status(400).send({ error: 'pattern too short or empty after normalize' });
      pattern = norm;
    }
    await pool.query(
      `INSERT INTO lead_blocklist (tenant_id, scope, pattern, display_name, created_by, created_via)
       VALUES ($1, $2, $3, $4, $5, 'dashboard')
       ON CONFLICT (tenant_id, scope, pattern) DO NOTHING`,
      [tid, scope, pattern, req.body?.display_name ?? patternRaw, req.user_email ?? null],
    );
    return { ok: true };
  });

app.delete<{ Params: { id: string } }>('/api/blocklist/:id', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const { rowCount } = await pool.query(
    `DELETE FROM lead_blocklist WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.tenant_id!],
  );
  return { ok: (rowCount ?? 0) > 0 };
});

// ----- comments list -----
app.get<{ Querystring: { limit?: string; group_id?: string; post_id?: string; q?: string } }>('/api/comments', async (req) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
  const where: string[] = ['c.deleted_at IS NULL', 'c.tenant_id = $1'];
  const params: unknown[] = [req.tenant_id!];
  if (req.query.group_id) { params.push(req.query.group_id); where.push(`p.group_id = $${params.length}`); }
  if (req.query.post_id)  { params.push(req.query.post_id);  where.push(`c.post_id = $${params.length}`); }
  if (req.query.q)        { params.push(`%${req.query.q}%`); where.push(`c.message ILIKE $${params.length}`); }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT c.comment_id, c.post_id, c.author_id, c.message, c.created_time, c.reaction_count,
            c.raw->'author'->>'name' AS author_name,
            p.group_id, g.name AS group_name,
            left(p.message, 80) AS post_preview
       FROM fact_group_post_comment c
       LEFT JOIN fact_group_post p ON p.post_id = c.post_id AND p.tenant_id = c.tenant_id
       LEFT JOIN dim_group g ON g.group_id = p.group_id AND g.tenant_id = p.tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_time DESC NULLS LAST
      LIMIT $${params.length}`,
    params
  );
  return { rows };
});

// ----- comments: groups that have comments (filter dropdown) -----
app.get('/api/comments/groups', async (req) => {
  const { rows } = await pool.query(
    `SELECT g.group_id, g.name, count(c.comment_id)::int AS n_comments
       FROM dim_group g
       JOIN fact_group_post p ON p.group_id = g.group_id AND p.tenant_id = g.tenant_id
       JOIN fact_group_post_comment c ON c.post_id = p.post_id AND c.tenant_id = p.tenant_id
      WHERE c.deleted_at IS NULL AND g.tenant_id = $1
      GROUP BY g.group_id, g.name
      ORDER BY g.name`,
    [req.tenant_id!]
  );
  return { rows };
});

// ----- posts: groups that actually have data (for filter dropdown) -----
app.get('/api/posts/groups', async (req) => {
  const { rows } = await pool.query(
    `SELECT g.group_id, g.name, count(p.post_id)::int AS n_posts
       FROM dim_group g
       JOIN fact_group_post p USING (group_id)
      WHERE p.deleted_at IS NULL AND g.tenant_id = $1 AND p.tenant_id = $1
      GROUP BY g.group_id, g.name
      ORDER BY g.name`,
    [req.tenant_id!]
  );
  return { rows };
});

// ----- single post detail (full message + raw payload for images/attachments) -----
app.get<{ Params: { id: string } }>('/api/posts/:id', async (req) => {
  const [postRes, cmtRes] = await Promise.all([
    pool.query(
      `SELECT p.*, g.name AS group_name
         FROM fact_group_post p
         LEFT JOIN dim_group g USING (group_id)
        WHERE p.post_id = $1 AND p.tenant_id = $2`,
      [req.params.id, req.tenant_id!]
    ),
    pool.query(
      `SELECT comment_id, author_id, message, created_time, reaction_count,
              raw->'author'->>'name'       AS author_name,
              raw->'author'->>'url'        AS author_profile,
              raw->'author'->>'__typename' AS author_typename
         FROM fact_group_post_comment
        WHERE post_id = $1 AND deleted_at IS NULL AND tenant_id = $2
        ORDER BY created_time ASC NULLS LAST`,
      [req.params.id, req.tenant_id!]
    ),
  ]);
  if (!postRes.rows[0]) return { ok: false };
  return { ok: true, row: postRes.rows[0], comments: cmtRes.rows };
});

// ----- posts -----
app.get<{ Querystring: { limit?: string; offset?: string; group_id?: string; q?: string } }>('/api/posts', async (req) => {
  const limit  = Math.min(500, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const filterParams: unknown[] = [req.tenant_id!];
  const where: string[] = ['p.deleted_at IS NULL', 'p.tenant_id = $1'];
  if (req.query.group_id) { filterParams.push(req.query.group_id); where.push(`p.group_id = $${filterParams.length}`); }
  if (req.query.q)        { filterParams.push(`%${req.query.q}%`);  where.push(`p.message ILIKE $${filterParams.length}`); }

  // Run count + page query in parallel.
  const [countRes, rowsRes] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM fact_group_post p WHERE ${where.join(' AND ')}`, filterParams),
    pool.query(
      `SELECT p.post_id, p.group_id, g.name AS group_name, p.author_id, p.permalink,
              p.message, p.story_type, p.created_time, p.reaction_count, p.comment_count, p.share_count
         FROM fact_group_post p
         LEFT JOIN dim_group g USING (group_id)
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_time DESC NULLS LAST
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      [...filterParams, limit, offset]
    ),
  ]);
  return { rows: rowsRes.rows, total: countRes.rows[0].n, limit, offset };
});

// ----- unified stream: posts LEFT JOIN fact_lead. Powers the Stream tab
// (merged from Posts + Leads + Kanban). One row per post; lead fields are
// NULL when post hasn't been classified as a lead.
//
// status filter values:
//   'all'          → every post
//   'leads'        → only posts with a lead
//   'nonleads'     → only posts without a lead
//   '<stage_value>' → leads at specific stage (e.g. 'new', 'contacted')
app.get<{ Querystring: {
  limit?: string; offset?: string; group_id?: string; q?: string;
  status?: string; intent?: string; post_id?: string;
} }>('/api/stream', async (req) => {
  const limit  = Math.min(2000, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const filterParams: unknown[] = [req.tenant_id!];
  const where: string[] = ['p.deleted_at IS NULL', 'p.tenant_id = $1'];

  if (req.query.post_id)  { filterParams.push(req.query.post_id);  where.push(`p.post_id = $${filterParams.length}`); }
  if (req.query.group_id) { filterParams.push(req.query.group_id); where.push(`p.group_id = $${filterParams.length}`); }
  if (req.query.q)        { filterParams.push(`%${req.query.q}%`);  where.push(`p.message ILIKE $${filterParams.length}`); }
  if (req.query.intent)   { filterParams.push(req.query.intent);    where.push(`l.intent = $${filterParams.length}`); }

  const status = req.query.status ?? 'all';
  if (status === 'leads')         where.push('l.lead_id IS NOT NULL');
  else if (status === 'nonleads') where.push('l.lead_id IS NULL');
  else if (status !== 'all')      { filterParams.push(status); where.push(`l.stage = $${filterParams.length}`); }

  const [countRes, rowsRes] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS n
         FROM fact_group_post p
         LEFT JOIN fact_lead l ON l.post_id = p.post_id AND l.tenant_id = p.tenant_id
        WHERE ${where.join(' AND ')}`,
      filterParams
    ),
    pool.query(
      `SELECT p.post_id, p.group_id, g.name AS group_name, p.author_id,
              p.permalink, p.message, p.created_time, p.is_anonymous_post,
              p.reaction_count, p.comment_count, p.share_count,
              p.raw->'actors'->0->>'name' AS author_name,
              p.raw->'actors'->0->>'url'  AS author_profile,
              l.lead_id, l.stage, l.intent, l.intent_confidence,
              l.detected_at, l.stage_changed_at, l.assigned_to
         FROM fact_group_post p
         LEFT JOIN fact_lead l ON l.post_id = p.post_id AND l.tenant_id = p.tenant_id
         LEFT JOIN dim_group g ON g.group_id = p.group_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_time DESC NULLS LAST
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      [...filterParams, limit, offset]
    ),
  ]);
  return { rows: rowsRes.rows, total: countRes.rows[0].n, limit, offset };
});

// ----- ETL runs -----
app.get<{ Querystring: { limit?: string } }>('/api/runs', async (req) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const { rows } = await pool.query(
    `SELECT id, kind, scope, started_at, finished_at, status, rows_total, rows_upserted, message
       FROM etl_run ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return { rows };
});

// ----- newly-discovered groups (added by the LATEST refresh and not yet
// enabled). We look at the last 2 successful fb_joined_groups runs: any
// group whose first_seen_at is after the prior run's finished_at counts as
// "new in the latest refresh". Limited to 25 to keep the CTA panel sane.
app.get('/api/groups/new', async (req) => {
  const { rows: refRows } = await pool.query(
    `SELECT finished_at
       FROM etl_run
      WHERE kind LIKE 'fb_joined_groups:%' AND status='ok' AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 2`
  );
  // Use the PRIOR refresh's finish time as the cutoff. If only 1 refresh
  // ever ran, fall back to "added in last hour" so we don't dump all 161.
  const cutoff = refRows[1]?.finished_at ?? new Date(Date.now() - 60 * 60_000);
  const { rows } = await pool.query(
    `SELECT group_id, name, url, first_seen_at
       FROM dim_group
      WHERE first_seen_at > $1
        AND enabled = FALSE
        AND deleted_at IS NULL
        AND tenant_id = $2
      ORDER BY first_seen_at DESC
      LIMIT 25`,
    [cutoff, req.tenant_id!]
  );
  return { rows };
});

// ----- one-click "enable + backfill" for a single group -----
app.post<{ Params: { id: string } }>('/api/groups/:id/enable-and-backfill', async (req) => {
  await pool.query(
    'UPDATE dim_group SET enabled = TRUE, updated_at = now() WHERE group_id = $1 AND tenant_id = $2',
    [req.params.id, req.tenant_id!]
  );
  // Fire-and-forget the backfill — it can take ~10 minutes per group.
  void runOne('fb_group_post', req.params.id, 'full').catch((e) => app.log.error({ err: String(e) }, 'enable+backfill runOne failed'));
  return { ok: true, started: true, group_id: req.params.id };
});

// ----- last joined-groups refresh time + count (for Groups tab CTA) -----
app.get('/api/groups/refresh-info', async () => {
  const { rows } = await pool.query(
    `SELECT id, started_at, finished_at, status, rows_upserted
       FROM etl_run
      WHERE kind LIKE 'fb_joined_groups:%'
        AND status IN ('ok', 'error', 'running')
      ORDER BY id DESC LIMIT 1`
  );
  return { last: rows[0] ?? null };
});

// ----- per-group post counts (used by Groups view) -----
app.get('/api/dashboard/group-post-counts', async (req) => {
  const { rows } = await pool.query(
    `SELECT group_id, count(*)::int AS n
       FROM fact_group_post WHERE deleted_at IS NULL AND tenant_id = $1
      GROUP BY group_id`,
    [req.tenant_id!]
  );
  return { rows };
});

// Daily Gemini token usage + estimated cost for the Settings tab cost dashboard.
// Returns up to `days` (default 14, max 90) most-recent days, including today.
app.get<{ Querystring: { days?: string } }>('/api/dashboard/gemini-usage', async (req) => {
  const tid = req.tenant_id!;
  const days = Math.min(90, Math.max(1, parseInt(req.query.days ?? '14', 10) || 14));
  const { rows } = await pool.query(
    `SELECT (called_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
            COALESCE(SUM(prompt_tokens),   0)::bigint AS prompt_tokens,
            COALESCE(SUM(output_tokens),   0)::bigint AS output_tokens,
            COALESCE(SUM(cached_tokens),   0)::bigint AS cached_tokens,
            COALESCE(SUM(thinking_tokens), 0)::bigint AS thinking_tokens,
            COALESCE(SUM(total_tokens),    0)::bigint AS total_tokens,
            COUNT(*)::bigint                          AS calls,
            COUNT(*) FILTER (WHERE NOT ok)::bigint    AS errors
       FROM gemini_usage
      WHERE tenant_id = $1 AND called_at > NOW() - ($2::text || ' days')::interval
      GROUP BY day ORDER BY day DESC`,
    [tid, String(days)],
  );
  const purposeRows = await pool.query(
    `SELECT purpose,
            COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COUNT(*)::bigint                        AS calls
       FROM gemini_usage
      WHERE tenant_id = $1 AND called_at > NOW() - ($2::text || ' days')::interval
      GROUP BY purpose ORDER BY (SUM(prompt_tokens)+SUM(output_tokens)) DESC`,
    [tid, String(days)],
  );
  const { getPricing, estimateCostUsd } = await import('./leads/gemini_usage.js');
  const p = getPricing();
  const enrich = (r: any) => {
    const cost_usd = estimateCostUsd(Number(r.prompt_tokens), Number(r.output_tokens), Number(r.cached_tokens), p);
    return { ...r, prompt_tokens: Number(r.prompt_tokens), output_tokens: Number(r.output_tokens),
             cached_tokens: Number(r.cached_tokens), thinking_tokens: Number(r.thinking_tokens),
             total_tokens: Number(r.total_tokens), calls: Number(r.calls), errors: Number(r.errors),
             cost_usd, cost_vnd: Math.round(cost_usd * p.usd_vnd) };
  };
  const daily = rows.map(enrich);
  const totals = daily.reduce((a: any, r: any) => ({
    prompt_tokens: a.prompt_tokens + r.prompt_tokens,
    output_tokens: a.output_tokens + r.output_tokens,
    cached_tokens: a.cached_tokens + r.cached_tokens,
    total_tokens:  a.total_tokens  + r.total_tokens,
    calls:         a.calls         + r.calls,
    errors:        a.errors        + r.errors,
    cost_usd:      a.cost_usd      + r.cost_usd,
    cost_vnd:      a.cost_vnd      + r.cost_vnd,
  }), { prompt_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, calls: 0, errors: 0, cost_usd: 0, cost_vnd: 0 });
  const by_purpose = purposeRows.rows.map((r: any) => {
    const cost_usd = estimateCostUsd(Number(r.prompt_tokens), Number(r.output_tokens), 0, p);
    return { purpose: r.purpose, calls: Number(r.calls),
             prompt_tokens: Number(r.prompt_tokens), output_tokens: Number(r.output_tokens),
             cost_usd, cost_vnd: Math.round(cost_usd * p.usd_vnd) };
  });
  return { days, model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash', pricing: p, daily, totals, by_purpose };
});

// ----- leads -----

app.get('/api/leads/enums', async () => ({
  stages: STAGE_VALUES.map((v) => ({ value: v, label: STAGE_LABELS[v] })),
  intents: INTENT_VALUES.map((v) => ({ value: v, label: INTENT_LABELS[v] })),
}));

app.get('/api/leads/stats', async (req) => {
  const tid = req.tenant_id!;
  const [byStage, byIntent, recent] = await Promise.all([
    pool.query(`SELECT stage, count(*)::int AS n FROM fact_lead WHERE tenant_id=$1 GROUP BY stage`, [tid]),
    pool.query(`SELECT intent, count(*)::int AS n FROM fact_lead WHERE tenant_id=$1 GROUP BY intent`, [tid]),
    pool.query(`SELECT count(*)::int AS n FROM fact_lead WHERE tenant_id=$1 AND detected_at >= now() - interval '24 hours'`, [tid]),
  ]);
  const stages: Record<string, number> = Object.fromEntries(STAGE_VALUES.map((v) => [v, 0]));
  for (const r of byStage.rows) stages[r.stage] = r.n;
  const intents: Record<string, number> = Object.fromEntries(INTENT_VALUES.map((v) => [v, 0]));
  for (const r of byIntent.rows) intents[r.intent] = r.n;
  return { stages, intents, recent_24h: recent.rows[0].n };
});

app.get<{ Querystring: { stage?: string; intent?: string; group_id?: string; q?: string; limit?: string; offset?: string } }>(
  '/api/leads',
  async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const where: string[] = ['l.tenant_id = $1'];
    const params: unknown[] = [req.tenant_id!];
    if (req.query.stage)    { params.push(req.query.stage);    where.push(`l.stage = $${params.length}`); }
    if (req.query.intent)   { params.push(req.query.intent);   where.push(`l.intent = $${params.length}`); }
    if (req.query.group_id) { params.push(req.query.group_id); where.push(`l.group_id = $${params.length}`); }
    if (req.query.q)        { params.push(`%${req.query.q}%`); where.push(`p.message ILIKE $${params.length}`); }
    params.push(limit); params.push(offset);
    const { rows } = await pool.query(
      `SELECT l.lead_id, l.intent, l.intent_confidence, l.intent_reason, l.intent_entities,
              l.stage, l.note, l.assigned_to, l.detected_at, l.stage_changed_at, l.updated_at,
              l.post_id, l.author_id, l.group_id,
              g.name AS group_name,
              p.message, p.created_time, p.permalink, p.reaction_count, p.comment_count, p.share_count,
              p.is_anonymous_post,
              p.raw->'actors'->0->>'name' AS author_name,
              p.raw->'actors'->0->>'url'  AS author_profile
         FROM fact_lead l
         LEFT JOIN fact_group_post p ON p.post_id = l.post_id AND p.tenant_id = l.tenant_id
         LEFT JOIN dim_group g ON g.group_id = l.group_id AND g.tenant_id = l.tenant_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.detected_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total FROM fact_lead l LEFT JOIN fact_group_post p ON p.post_id = l.post_id AND p.tenant_id = l.tenant_id WHERE ${where.join(' AND ')}`,
      params.slice(0, -2)
    );
    return { rows, paging: { limit, offset, total: countRows[0].total } };
  }
);

app.get<{ Params: { id: string } }>('/api/leads/:id', async (req) => {
  const tid = req.tenant_id!;
  const [leadRes, histRes, cmtRes] = await Promise.all([
    pool.query(
      `SELECT l.*, p.message, p.created_time, p.permalink, p.reaction_count, p.comment_count, p.share_count,
              p.is_anonymous_post, p.attachment_url, p.raw AS post_raw, g.name AS group_name
         FROM fact_lead l
         LEFT JOIN fact_group_post p ON p.post_id = l.post_id AND p.tenant_id = l.tenant_id
         LEFT JOIN dim_group g ON g.group_id = l.group_id AND g.tenant_id = l.tenant_id
        WHERE l.lead_id = $1 AND l.tenant_id = $2`,
      [req.params.id, tid]
    ),
    pool.query(
      `SELECT h.id, h.action, h.from_value, h.to_value, h.note, h.actor, h.created_at
         FROM lead_history h
         JOIN fact_lead l ON l.lead_id = h.lead_id
        WHERE h.lead_id = $1 AND l.tenant_id = $2
        ORDER BY h.created_at DESC`,
      [req.params.id, tid]
    ),
    pool.query(
      `SELECT c.comment_id, c.author_id, c.message, c.created_time, c.reaction_count,
              c.raw->'author'->>'name' AS author_name
         FROM fact_group_post_comment c
        WHERE c.tenant_id = $2
          AND c.post_id = (SELECT post_id FROM fact_lead WHERE lead_id = $1 AND tenant_id = $2)
          AND c.deleted_at IS NULL
        ORDER BY c.created_time ASC NULLS LAST`,
      [req.params.id, tid]
    ),
  ]);
  if (!leadRes.rows[0]) return { ok: false };
  return { ok: true, lead: leadRes.rows[0], history: histRes.rows, comments: cmtRes.rows };
});

app.patch<{ Params: { id: string }; Body: { stage?: Stage; note?: string; assigned_to?: string } }>(
  '/api/leads/:id',
  async (req) => {
    const updates: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    const historyEntries: Array<{ action: string; from?: string; to?: string; note?: string }> = [];

    // Get current state to log diff
    const { rows: curRows } = await pool.query(
      'SELECT stage, note, assigned_to FROM fact_lead WHERE lead_id = $1 AND tenant_id = $2',
      [req.params.id, req.tenant_id!]
    );
    if (!curRows[0]) return { ok: false, error: 'lead not found' };
    const cur = curRows[0];

    if (req.body.stage && STAGE_VALUES.includes(req.body.stage) && req.body.stage !== cur.stage) {
      updates.push(`stage = $${p++}`, `stage_changed_at = now()`);
      params.push(req.body.stage);
      historyEntries.push({ action: 'stage_changed', from: cur.stage, to: req.body.stage });
    }
    if (req.body.note !== undefined && req.body.note !== cur.note) {
      updates.push(`note = $${p++}`);
      params.push(req.body.note);
      historyEntries.push({ action: 'note_updated', from: cur.note ?? '', to: req.body.note });
    }
    if (req.body.assigned_to !== undefined && req.body.assigned_to !== cur.assigned_to) {
      updates.push(`assigned_to = $${p++}`);
      params.push(req.body.assigned_to);
      historyEntries.push({ action: 'assigned', from: cur.assigned_to ?? '', to: req.body.assigned_to });
    }
    if (updates.length === 0) return { ok: true, no_changes: true };

    updates.push('updated_at = now()');
    params.push(req.params.id);
    params.push(req.tenant_id!);
    await pool.query(
      `UPDATE fact_lead SET ${updates.join(', ')} WHERE lead_id = $${p++} AND tenant_id = $${p}`,
      params
    );
    for (const h of historyEntries) {
      await pool.query(
        `INSERT INTO lead_history (lead_id, action, from_value, to_value, actor) VALUES ($1, $2, $3, $4, 'user')`,
        [req.params.id, h.action, h.from ?? null, h.to ?? null]
      );
    }
    return { ok: true, changes: historyEntries.length };
  }
);

app.post<{ Params: { id: string }; Body: { note: string } }>('/api/leads/:id/note', async (req) => {
  if (!req.body.note?.trim()) return { ok: false, error: 'empty note' };
  const { rows } = await pool.query(
    `INSERT INTO lead_history (lead_id, action, note, actor) VALUES ($1, 'note_added', $2, 'user') RETURNING id`,
    [req.params.id, req.body.note.trim()]
  );
  return { ok: true, history_id: rows[0].id };
});

app.post<{ Body?: { limit?: number; force?: boolean } }>('/api/leads/classify-backfill', async (req) => {
  const limit = Math.min(500, Math.max(1, Number(req.body?.limit ?? 50)));
  // Find posts (with text) that have no lead row yet OR have lead unclassified.
  const { rows: posts } = await pool.query(
    `SELECT p.post_id, p.group_id, p.author_id, p.message, g.name AS group_name
       FROM fact_group_post p
       LEFT JOIN dim_group g ON g.group_id = p.group_id AND g.tenant_id = p.tenant_id
       LEFT JOIN fact_lead l ON l.post_id = p.post_id AND l.tenant_id = p.tenant_id
      WHERE p.message IS NOT NULL AND length(trim(p.message)) > 0
        AND p.tenant_id = $1
        AND (l.lead_id IS NULL OR l.classified_at IS NULL OR $2 = TRUE)
      ORDER BY p.created_time DESC NULLS LAST
      LIMIT $3`,
    [req.tenant_id!, !!req.body?.force, limit]
  );
  let classified = 0;
  let errors = 0;
  for (const p of posts) {
    try {
      await maybeCreateLead({
        post_id: p.post_id,
        group_id: p.group_id,
        group_name: p.group_name,
        author_id: p.author_id,
        message: p.message,
      });
      classified++;
    } catch (e: any) {
      errors++;
      app.log.warn({ err: e?.message ?? String(e), post_id: p.post_id }, 'classify-backfill error');
    }
  }
  return { ok: true, attempted: posts.length, classified, errors };
});

// Wipe + re-classify ALL posts against current tenant rules. Destructive —
// drops existing fact_lead rows (and lead_history via CASCADE) + rule-cache
// for this tenant, then runs maybeCreateLead on every post.
// Returns immediately; classification runs in background.
app.post('/api/leads/reclassify-all', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const tid = req.tenant_id!;

  // Count posts to give user an estimate before kicking off
  const { rows: [{ posts: postCount }] } = await pool.query(
    `SELECT count(*)::int AS posts FROM fact_group_post
      WHERE tenant_id=$1 AND message IS NOT NULL AND length(trim(message))>0`,
    [tid]
  );

  // 1. Drop existing leads for this tenant. lead_history cascades via FK.
  const { rowCount: deletedLeads } = await pool.query(
    `DELETE FROM fact_lead WHERE tenant_id = $1`, [tid]
  );
  // 2. Drop rules cache entries (so changed rules force fresh Gemini calls).
  //    Enum-mode cache is left alone (shared across tenants).
  const { rowCount: deletedCache } = await pool.query(
    `DELETE FROM lead_classifier_cache WHERE model LIKE 'rules:%'`
  );

  // 3. Kick off async reclassification — don't block the HTTP response.
  void (async () => {
    try {
      const { rows: posts } = await pool.query(
        `SELECT p.post_id, p.group_id, p.author_id, p.message, g.name AS group_name
           FROM fact_group_post p LEFT JOIN dim_group g ON g.group_id=p.group_id
          WHERE p.tenant_id=$1 AND p.message IS NOT NULL AND length(trim(p.message))>0
          ORDER BY p.created_time DESC NULLS LAST`,
        [tid]
      );
      let ok = 0, err = 0;
      for (const p of posts) {
        try { await maybeCreateLead({ post_id: p.post_id, group_id: p.group_id, group_name: p.group_name, author_id: p.author_id, message: p.message, tenant_id: tid }); ok++; }
        catch (e: any) { err++; app.log.warn({ err: e?.message, post_id: p.post_id }, 'reclassify-all error'); }
      }
      app.log.info({ tid, ok, err, total: posts.length }, 'reclassify-all finished');
    } catch (e: any) {
      app.log.error({ err: e?.message, tid }, 'reclassify-all crashed');
    }
  })();

  return {
    ok: true,
    message: `Đã xoá ${deletedLeads ?? 0} leads + ${deletedCache ?? 0} cache. Đang re-classify ${postCount} posts ở background — refresh Leads tab sau ~5 phút.`,
    deleted_leads: deletedLeads ?? 0,
    deleted_cache: deletedCache ?? 0,
    posts_to_classify: postCount,
  };
});

// ----- lead reports (Phase C4) -----
app.get('/api/leads/funnel',       async (req) => await getFunnel(req.tenant_id!));
app.get<{ Querystring: { days?: string } }>('/api/leads/daily-stats', async (req) =>
  await getDailyStats(req.tenant_id!, Math.min(180, Math.max(1, Number(req.query.days ?? 30))))
);
app.get('/api/leads/velocity',     async (req) => await getVelocity(req.tenant_id!));
app.get('/api/leads/heatmap',      async (req) => await getHeatmap(req.tenant_id!));

// ----- comment insights (weekly aggregation) -----
app.get('/api/insights', async (req) => {
  const { rows } = await pool.query(
    `SELECT week_start, category, total_comments, top_commenters, hot_threads, gemini_summary, generated_at
       FROM comment_insights WHERE tenant_id = $1
      ORDER BY week_start DESC, category`,
    [req.tenant_id!]
  );
  return { rows };
});
app.post('/api/insights/generate', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  // Run synchronously so the user sees results immediately; ~5-15s incl. Gemini.
  const n = await runCommentInsights(req.tenant_id!);
  return { ok: true, buckets: n };
});

// ----- tenant settings (per-customer config) -----
app.get('/api/settings', async (req) => ({ tenant_id: req.tenant_id!, config: await getTenantConfig(req.tenant_id!) }));

app.patch<{ Body: Partial<TenantConfig> }>('/api/settings', async (req) => {
  const prev = await getTenantConfig(req.tenant_id!);
  const cfg  = await patchTenantConfig(req.tenant_id!, req.body ?? {});
  // If the customer added/changed the Telegram bot_token, (re)register the
  // webhook so /post + reply approve flow works without dashboard.
  if (cfg.telegram_bot_token && cfg.telegram_bot_token !== prev.telegram_bot_token) {
    void registerTelegramWebhookForTenant(req.tenant_id!, cfg.telegram_bot_token)
      .catch((e) => console.warn(`[tg-webhook] register failed tenant=${req.tenant_id}: ${e?.message ?? e}`));
  }
  return { ok: true, config: cfg };
});

/**
 * Generate a per-tenant secret + call Telegram setWebhook so updates POST to
 * /api/telegram/wh/:secret. Idempotent — re-registering with the same token
 * just rotates the secret + URL. Fire-and-forget from settings save.
 */
async function registerTelegramWebhookForTenant(tenantId: string, botToken: string): Promise<void> {
  const { randomBytes } = await import('node:crypto');
  const { setWebhook }  = await import('./telegram/api.js');
  const secret = randomBytes(24).toString('hex'); // 48 chars
  const base = process.env.APP_PUBLIC_BASE_URL ?? 'https://fb.autonow.vn';
  const url  = `${base.replace(/\/$/, '')}/api/telegram/wh/${secret}`;
  const r = await setWebhook(botToken, url, secret);
  if (!r.ok) {
    console.warn(`[tg-webhook] setWebhook failed tenant=${tenantId}: ${r.description}`);
    return;
  }
  await patchTenantConfig(tenantId, { telegram_webhook_secret: secret });
  console.log(`[tg-webhook] registered tenant=${tenantId} url=${url}`);
}

// ----- Telegram notification test -----
app.post('/api/settings/telegram/test', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const { sendTelegramTest } = await import('./leads/notifier.js');
  const r = await sendTelegramTest(req.tenant_id!);
  if (r.ok) return { ok: true, message: '✅ Đã gửi message thử — check Telegram của bạn' };
  return reply.status(400).send({ ok: false, error: r.error || 'Gửi thất bại' });
});

// ----- Telegram: detect forum topics inside the saved chat -----
// Lists unique (thread_id, name) the bot has seen messages in. User picks
// which thread = HR vs Fulfill in Settings.
app.post('/api/settings/telegram/detect-topics', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const cfg = await getTenantConfig(req.tenant_id!);
  const token = cfg.telegram_bot_token;
  const chatId = cfg.telegram_chat_id;
  if (!token || !chatId) return reply.status(400).send({ ok: false, error: 'Cần lưu bot_token + chat_id trước' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(10000) });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) return reply.status(400).send({ ok: false, error: j.description || 'Telegram error' });
    const seen = new Map<number, string>();
    for (const upd of (j.result ?? []).slice().reverse()) {
      const msg = upd.message ?? upd.edited_message ?? null;
      if (!msg) continue;
      if (String(msg.chat?.id) !== String(chatId)) continue;
      const threadId = msg.message_thread_id;
      if (!threadId) continue; // General (default channel) has no thread_id
      // The topic name appears in forum_topic_created events; fall back to a placeholder.
      const name = msg.forum_topic_created?.name ?? msg.reply_to_message?.forum_topic_created?.name ?? `Topic #${threadId}`;
      if (!seen.has(threadId)) seen.set(threadId, name);
    }
    const topics = Array.from(seen.entries()).map(([id, name]) => ({ thread_id: id, name }));
    if (topics.length === 0) {
      return { ok: true, topics: [], message: 'Chưa thấy topic nào. Hãy gửi 1 tin nhắn bất kỳ vào mỗi topic (HR + Fulfill) rồi click Detect lại.' };
    }
    return { ok: true, topics };
  } catch (e: any) {
    return reply.status(500).send({ ok: false, error: e?.message ?? String(e) });
  }
});

// ----- Telegram: auto-detect chat_id from bot's recent updates -----
// Calls Telegram getUpdates with the supplied bot token; returns the most
// recent unique chats the bot has been messaged from. User just /start's the
// bot and clicks "Detect" — no manual chat_id copy/paste needed.
app.post<{ Body: { bot_token?: string } }>('/api/settings/telegram/detect-chat', async (req, reply) => {
  if (!req.user_id) return reply.status(401).send({ error: 'unauthorized' });
  const token = (req.body?.bot_token ?? '').trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return reply.status(400).send({ ok: false, error: 'Bot token sai định dạng (phải dạng 123456:ABC...)' });
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50`, {
      signal: AbortSignal.timeout(10000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) {
      return reply.status(400).send({ ok: false, error: j.description || 'Telegram API rejected token' });
    }
    // Collect unique chats from recent updates (newest first).
    const seen = new Map<string, { id: number; type: string; title: string }>();
    for (const upd of (j.result ?? []).slice().reverse()) {
      const msg = upd.message ?? upd.edited_message ?? upd.channel_post ?? null;
      const chat = msg?.chat;
      if (!chat?.id) continue;
      const key = String(chat.id);
      if (seen.has(key)) continue;
      seen.set(key, {
        id:    chat.id,
        type:  chat.type,
        title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || `Chat ${chat.id}`,
      });
    }
    const chats = Array.from(seen.values());
    if (chats.length === 0) {
      return { ok: true, chats: [], message: 'Bot chưa nhận message nào. Hãy mở Telegram → tìm bot → bấm Start (/start), rồi click Detect lại.' };
    }
    return { ok: true, chats };
  } catch (e: any) {
    return reply.status(500).send({ ok: false, error: e?.message ?? String(e) });
  }
});

// ----- dashboard -----
app.get('/api/dashboard/stats', async (req) => {
  const tid = req.tenant_id!;
  const [groups, posts, comments, runs, sess, lastWm, tenantCfg] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE is_joined=TRUE)                       AS joined,
                       count(*) FILTER (WHERE is_joined=TRUE AND enabled=TRUE)      AS enabled
                  FROM dim_group WHERE tenant_id = $1`, [tid]),
    pool.query('SELECT count(*) FROM fact_group_post WHERE deleted_at IS NULL AND tenant_id = $1', [tid]),
    pool.query('SELECT count(*) FROM fact_group_post_comment WHERE deleted_at IS NULL AND tenant_id = $1', [tid]),
    pool.query(
      `SELECT id, kind, scope, started_at, finished_at, status, rows_upserted, message
         FROM etl_run WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [tid]
    ),
    pool.query(`SELECT c_user, created_at FROM fb_session WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`),
    pool.query(`SELECT max(started_at) AS last_run_at FROM etl_run WHERE status='ok' AND tenant_id=$1`, [tid]),
    pool.query(`SELECT config->>'fb_display_name' AS fb_display_name, config->>'fb_avatar_url' AS fb_avatar_url FROM tenant_settings WHERE tenant_id=$1`, [tid]),
  ]);
  const session = sess.rows[0]
    ? { ...sess.rows[0], display_name: tenantCfg.rows[0]?.fb_display_name ?? null, avatar_url: tenantCfg.rows[0]?.fb_avatar_url ?? null }
    : null;
  return {
    session,
    last_sync_at: lastWm.rows[0]?.last_run_at ?? null,
    counts: {
      groups:         Number(groups.rows[0].joined),
      groups_enabled: Number(groups.rows[0].enabled),
      posts:          Number(posts.rows[0].count),
      comments:       Number(comments.rows[0].count),
    },
    recent_runs: runs.rows,
  };
});

// ----- root HTML — landing for anon, dashboard for authed -----
app.get('/', async (req, reply) => {
  if (!req.user_id) {
    return reply.type('text/html').send(renderLanding());
  }
  // Force browsers (and CF) to revalidate every reload — the dashboard JS is
  // inlined in this HTML so we never want a stale copy after a deploy.
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.type('text/html').send(renderApp());
});

// ----- agent installer (templated) -----
// Reads agent/install.sh from disk on each request, replaces __CLOUD_BASE_URL__
// with this deployment's public URL. The tarball at /agent/latest.tgz contains
// the same script unmodified — only the entry-point that curl pipes to bash is
// templated, so multiple cloud deployments can serve the same tarball.
const INSTALL_SH_PATH = resolvePath(process.cwd(), 'agent/install.sh');
app.get('/install.sh', async (_req, reply) => {
  const baseUrl = process.env.APP_PUBLIC_BASE_URL ?? 'https://fb.autonow.vn';
  let script: string;
  try {
    script = readFileSync(INSTALL_SH_PATH, 'utf8');
  } catch (e: any) {
    return reply.status(500).type('text/plain').send(
      `#!/usr/bin/env bash\necho "ERROR: installer not built. Contact admin."\nexit 1\n`
    );
  }
  reply.type('text/plain').send(script.replaceAll('__CLOUD_BASE_URL__', baseUrl));
});

// ----- Facebook launcher bridge page -----
// User clicks "Mở Facebook" on dashboard → opens new tab to this page.
// Page calls /api/dashboard/agent/command (open_login), polls status, and
// redirects to noVNC URL as soon as Chrome is ready on the agent. Removes the
// "click → wait → click again" double-step UX confusion.
app.get<{ Querystring: { url?: string } }>('/fb-launcher', async (req, reply) => {
  if (!req.user_id) return reply.redirect('/auth/login');
  const preselect = (req.query.url ?? '').slice(0, 500);
  reply.type('text/html').send(`<!doctype html>
<html lang="vi" class=""><head>
<meta charset="utf-8"><title>Đang mở Facebook…</title>
<script>(function(){try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/public/tailwind.css">
<style>
  body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .spinner { width:48px; height:48px; border:4px solid hsl(var(--border)); border-top-color:hsl(var(--primary)); border-radius:50%; margin:0 auto 20px; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head><body class="bg-background text-foreground min-h-screen flex items-center justify-center p-4">
<div class="ui-card max-w-lg w-full p-8 text-center">
  <div id="entryForm">
    <h1 class="text-xl font-semibold tracking-tight m-0 mb-2">📱 Mở Facebook trên VPS</h1>
    <p class="text-sm text-muted-foreground mb-5">Chrome sẽ khởi động trên VPS rồi stream về browser này qua noVNC. ~1-2 phút lần đầu.</p>
    <div class="text-left">
      <label class="block text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">URL group muốn mở thẳng (optional)</label>
      <input id="navUrl" type="text" placeholder="https://www.facebook.com/groups/..." class="form-input w-full mb-1" value="${preselect.replace(/"/g, '&quot;')}">
      <p class="text-[11px] text-muted-foreground m-0 mb-4">Để trống → mở facebook.com home. Có URL → Chrome mở thẳng group đó, click Join là xong.</p>
    </div>
    <button id="btnStart" class="btn btn-primary w-full justify-center py-2.5">🚀 Bắt đầu</button>
  </div>

  <div id="progress" class="hidden">
    <div class="spinner"></div>
    <h1 id="title" class="text-xl font-semibold tracking-tight m-0 mb-2">Đang mở Facebook trên VPS của bạn…</h1>
    <p class="text-sm text-muted-foreground mb-5">Chrome cần khởi động trên VPS rồi stream về browser này qua noVNC. ~1-2 phút lần đầu.</p>
    <div class="bg-muted/50 rounded-md p-4 mb-4 text-sm text-left space-y-1.5">
      <div class="step text-muted-foreground" id="s1"><span class="inline-block w-5">⏳</span> Gửi lệnh đến cloud</div>
      <div class="step text-muted-foreground" id="s2"><span class="inline-block w-5">⏳</span> Agent nhận lệnh (đợi heartbeat)</div>
      <div class="step text-muted-foreground" id="s3"><span class="inline-block w-5">⏳</span> Chrome khởi động</div>
      <div class="step text-muted-foreground" id="s4"><span class="inline-block w-5">⏳</span> noVNC sẵn sàng</div>
    </div>
    <div class="text-[11px] font-mono text-primary" id="elapsed">0s</div>
    <div class="text-xs text-destructive mt-3" id="err"></div>
  </div>
</div>
<script>
const startT = Date.now();
function mark(id, state) {
  const el = document.getElementById(id);
  el.className = 'step text-muted-foreground';
  if (state === 'done')   { el.className = 'step text-success font-medium';     el.querySelector('span').textContent = '✓'; }
  if (state === 'active') { el.className = 'step text-foreground font-medium';  el.querySelector('span').textContent = '⏳'; }
}
function setTitle(t) { document.getElementById('title').textContent = t; }
setInterval(()=>{ const e=document.getElementById('elapsed'); if (e) e.textContent = Math.round((Date.now()-startT)/1000) + 's'; }, 1000);

async function launch(navUrl) {
  document.getElementById('entryForm').classList.add('hidden');
  document.getElementById('progress').classList.remove('hidden');
  mark('s1','active');
  try {
    const r = await fetch('/api/dashboard/agent/command', {
      method:'POST', credentials:'same-origin',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({cmd:'open_login', nav_url: navUrl || null}),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.message || j.error || 'failed to queue');
    mark('s1','done');
    mark('s2','active');
  } catch(e) {
    document.getElementById('err').textContent = '❌ ' + e.message;
    return;
  }
  // poll status until login_active && vnc_public_url
  let redirected = false;
  const poll = setInterval(async () => {
    try {
      const s = await fetch('/api/dashboard/agent/status', {credentials:'same-origin'}).then(r=>r.json());
      if (!s.installed) { document.getElementById('err').textContent = '❌ Agent chưa cài trên VPS'; clearInterval(poll); return; }
      if (s.pending_commands && s.pending_commands.length === 0 && s.last_command === 'open_login') mark('s2','done');
      if (!s.login_active && s.last_command === 'open_login') { mark('s2','done'); mark('s3','active'); }
      if (s.login_active) {
        mark('s2','done'); mark('s3','done'); mark('s4','active');
        if (s.vnc_public_url && !redirected) {
          redirected = true;
          setTitle('Đang chuyển sang Facebook…');
          mark('s4','done');
          clearInterval(poll);
          setTimeout(() => { location.href = s.vnc_public_url; }, 600);
        }
      }
    } catch(e) {
      document.getElementById('err').textContent = '⚠ Lỗi mạng — retry: ' + e.message;
    }
  }, 3000);
}

document.getElementById('btnStart').addEventListener('click', () => {
  const u = document.getElementById('navUrl').value.trim();
  launch(u);
});
// Auto-start if URL was passed as query param
const preselectInput = document.getElementById('navUrl');
if (preselectInput.value.trim().length > 0) launch(preselectInput.value.trim());
</script>
</body></html>`);
});

function renderApp(): string {
  return `<!doctype html>
<html lang="vi" class="">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>auto_facebook · FB Joined Groups</title>

<!-- Avoid FOUC: set theme class before paint -->
<script>(function(){try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();</script>

<!-- Inter font (shadcn-style typography) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

<!-- Compiled Tailwind CSS (JIT-built via npm run build:css) -->
<link rel="stylesheet" href="/public/tailwind.css">

<style>
  /* ── shadcn-style HSL tokens (light default; dark via .dark) ─────── */
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 240 60% 50%;            /* indigo-600 in HSL */
    --primary-foreground: 0 0% 100%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --success: 142 71% 45%;
    --success-foreground: 0 0% 100%;
    --warning: 38 92% 50%;
    --warning-foreground: 0 0% 100%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 240 60% 50%;
    --radius: 0.625rem;

    /* Legacy aliases (so old inline-style code keeps working until refactored) */
    --bg: #ffffff;
    --bg-sidebar: #fafafa;
    --bg-topbar: #ffffff;
    --bg-card: #ffffff;
    --bg-input: #f4f4f5;
    --bg-hover: #f4f4f5;
    --bg-active: #eef2ff;
    --border-strong: #d4d4d8;
    --text: #09090b;
    --text-2: #3f3f46;
    --text-muted: #71717a;
    --accent-soft: #eef2ff;
    --success-soft: #dcfce7;
    --danger: #ef4444;
    --danger-soft: #fee2e2;
    --warning-soft: #fef3c7;
    --shadow-sm:    0 1px 2px 0 rgb(0 0 0 / 0.04);
    --shadow:       0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.04);
    --shadow-lg:    0 10px 30px -10px rgb(0 0 0 / 0.15), 0 4px 12px -4px rgb(0 0 0 / 0.08);
    --radius-sm:    5px;
  }
  .dark {
    --background: 240 10% 4%;
    --foreground: 210 40% 98%;
    --card: 240 10% 6%;
    --card-foreground: 210 40% 98%;
    --popover: 240 10% 6%;
    --popover-foreground: 210 40% 98%;
    --primary: 217 91% 60%;            /* brighter blue for dark */
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 50.6%;
    --destructive-foreground: 210 40% 98%;
    --success: 142 65% 50%;
    --warning: 48 96% 53%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 224.3 76.3% 48%;

    --bg: #0a0a0f;
    --bg-sidebar: #0d0d12;
    --bg-topbar: #0d0d12;
    --bg-card: #0f1117;
    --bg-input: #131520;
    --bg-hover: #1a1d2a;
    --bg-active: #1f2937;
    --border-strong: #2a2d3a;
    --text: #f8fafc;
    --text-2: #cbd5e1;
    --text-muted: #94a3b8;
    --accent-soft: #1e1b4b;
    --success-soft: #052e16;
    --danger: #f87171;
    --danger-soft: #450a0a;
    --warning: #fbbf24;
    --warning-soft: #451a03;
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.3);
    --shadow:    0 4px 12px rgb(0 0 0 / 0.4);
    --shadow-lg: 0 14px 36px -10px rgb(0 0 0 / 0.55);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); overflow: hidden; transition: background 0.2s, color 0.2s; font-feature-settings: 'cv11', 'ss01'; -webkit-font-smoothing: antialiased; }
  body { display: grid; grid-template-columns: 248px 1fr; grid-template-rows: 100dvh; }

  /* SIDEBAR — most styling moved to Tailwind classes on the elements;
     only active-nav state + pills need bespoke CSS */
  nav#nav a.active { background: hsl(var(--accent)); color: hsl(var(--foreground)); font-weight: 600; }
  .pill { padding: 2px 9px; background: var(--bg-hover); border-radius: 999px; font-size: 10px; color: var(--text-2); white-space: nowrap; font-weight: 500; }
  .pill.live { background: var(--success-soft); color: var(--success); }
  .pill.warn { background: var(--warning-soft); color: var(--warning); }
  .pill.err  { background: var(--danger-soft); color: var(--danger); }

  /* MAIN AREA */
  main { display: grid; grid-template-rows: auto 1fr; min-height: 0; background: var(--bg); }
  .topbar { padding: 12px 24px; background: var(--bg-topbar); border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: center; }
  .topbar h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
  .topbar .spacer { flex: 1; }

  /* Theme toggle — overrides the generic button { padding } below */
  button.theme-toggle { background: transparent; color: var(--text-2); border: 1px solid hsl(var(--border)); width: 32px; height: 32px; padding: 0; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; transition: background 0.12s; flex-shrink: 0; }
  button.theme-toggle:hover { background: hsl(var(--accent)); filter: none; }

  button { background: var(--accent); color: white; border: 0; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; transition: filter 0.12s, transform 0.06s; }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); }
  button.secondary { background: var(--bg-input); color: var(--text); border: 1px solid var(--border-strong); }
  button.secondary:hover { background: var(--bg-hover); }
  button.danger { background: var(--danger); }
  button.success { background: var(--success); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }

  input, select, textarea { background: var(--bg-input); color: var(--text); border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 10px; font-size: 13px; font-family: inherit; transition: border 0.12s; }
  input:focus, select:focus, textarea:focus { outline: 0; border-color: var(--accent); }

  .view { padding: 22px 28px; overflow-y: auto; min-height: 0; background: var(--bg); }
  .view.hidden { display: none; }
  .hidden { display: none !important; }

  /* CARDS */
  .grid-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow-sm); transition: box-shadow 0.15s; }
  .card:hover { box-shadow: var(--shadow); }
  .card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin: 0 0 8px; font-weight: 600; }
  .card .v { font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--text); letter-spacing: -0.02em; }
  .card .sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  @media (max-width: 1100px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow-sm); }
  .panel h3 { font-size: 13px; margin: 0 0 12px; color: var(--text); font-weight: 600; letter-spacing: -0.01em; }
  .panel.wide { grid-column: 1 / -1; }

  /* TABLES */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.fixed-table { table-layout: fixed; }
  table.fixed-table td, table.fixed-table th { overflow: hidden; text-overflow: ellipsis; }
  table.fixed-table td code { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; word-break: break-all; white-space: normal; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:hover td { background: var(--bg-hover); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.muted { color: var(--text-muted); }
  code { background: var(--bg-input); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-family: ui-monospace, monospace; color: var(--text-2); }
  pre { background: var(--bg-input); color: var(--text-2); padding: 12px; border-radius: 6px; font-size: 11px; overflow: auto; max-height: 380px; white-space: pre-wrap; word-break: break-all; }

  /* IFRAME */
  .iframe-wrap { position: relative; height: calc(100dvh - 140px); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: #000; }
  .iframe-wrap iframe { width: 100%; height: 100%; border: 0; background: #000; display: block; }

  /* TOASTS */
  #toasts { position: fixed; top: 16px; right: 16px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
  .toast { background: var(--bg-card); color: var(--text); padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: var(--shadow-lg); border: 1px solid var(--border); border-left: 4px solid var(--accent); max-width: 360px; pointer-events: auto; animation: slideIn .18s ease; }
  .toast.success { border-left-color: var(--success); }
  .toast.error   { border-left-color: var(--danger); }
  @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .row-flex { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .muted { color: var(--text-muted); font-size: 11px; }
  .s-ok      { color: var(--success); font-weight: 500; }
  .s-running { color: var(--warning); font-weight: 500; }
  .s-error   { color: var(--danger); font-weight: 500; }
  .s-aborted { color: var(--danger); font-weight: 500; }

  /* SLIDE-IN DETAIL */
  .row-detail { position: fixed; right: 0; top: 0; bottom: 0; width: 580px; max-width: 90vw; background: var(--bg-card); border-left: 1px solid var(--border-strong); box-shadow: -8px 0 32px rgba(0,0,0,0.5); padding: 18px 22px; overflow-y: auto; transform: translateX(100%); transition: transform 0.2s ease; z-index: 100; }
  .row-detail.open { transform: translateX(0); }
  .row-detail h3 { margin: 0 0 14px; font-size: 14px; color: #fff; }
  .row-detail .closebtn { position: absolute; top: 12px; right: 14px; background: transparent; color: var(--text-muted); border: 0; font-size: 18px; cursor: pointer; }
  .row-detail dt { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 12px; font-family: ui-monospace, monospace; }
  .row-detail dd { margin: 4px 0 0; font-size: 12px; word-break: break-all; white-space: pre-wrap; font-family: ui-monospace, monospace; background: var(--bg-input); padding: 6px 9px; border-radius: 4px; max-height: 220px; overflow-y: auto; }

  @media (max-width: 860px) {
    body { grid-template-columns: 1fr; }
    aside { display: none; }
    .panels { grid-template-columns: 1fr; }
  }
</style>
<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
</head>
<body>

<aside class="bg-card border-r border-border flex flex-col min-h-0 py-4">
  <div class="px-5 pb-4 border-b border-border">
    <div class="font-semibold text-[15px] tracking-tight text-foreground">auto_facebook</div>
    <div class="text-[11px] text-muted-foreground mt-0.5">FB Joined Groups · Postgres</div>
  </div>
  <nav class="flex-1 overflow-y-auto py-3 px-2 space-y-0.5" id="nav">
    <a data-view="dashboard" class="active flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">📊</span><span>Dashboard</span></a>
    <a data-view="discover" id="navDiscover" style="display:none" class="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">🔍</span><span>Discover XHR</span></a>
    <a data-view="groups"   class="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">👥</span><span>Groups</span></a>
    <a data-view="stream"   class="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">📥</span><span>Stream</span></a>
    <a data-view="compose"  class="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">📝</span><span>Đăng bài</span></a>
    <a data-view="replies"  class="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">💬</span><span>Duyệt reply</span></a>
    <a data-view="setup"    class="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"><span class="text-base">⚙</span><span>Setup</span></a>
  </nav>
  <div class="px-5 py-3 border-t border-border space-y-1 text-[11px] text-muted-foreground">
    <div class="flex justify-between gap-2"><span>Session</span><span class="pill" id="sideSession">…</span></div>
    <div class="flex justify-between gap-2"><span>Last sync</span><span class="pill" id="sideSync">…</span></div>
    <div class="flex justify-between gap-2"><span>Discover</span><span class="pill" id="sideDisc">idle</span></div>
    <div class="flex justify-between gap-2 mt-2"><span>Cron</span><span class="pill" id="sideCron">…</span></div>
  </div>
</aside>

<main>
  <div class="topbar flex items-center gap-2 px-6 py-3 bg-card border-b border-border">
    <h2 id="topTitle" class="m-0 text-[16px] font-semibold tracking-tight text-foreground">Dashboard</h2>
    <span class="flex-1"></span>
    <button class="theme-toggle inline-flex items-center justify-center w-8 h-8 rounded-md text-foreground hover:bg-accent transition-colors text-sm" id="btnTheme" title="Toggle theme">🌙</button>
    <button class="secondary" id="btnRefresh">↻ Refresh</button>
  </div>

  <!-- DASHBOARD -->
  <div class="view" data-view="dashboard">
    <!-- Status banner -->
    <div id="dashStatusBanner" class="ui-card p-4 mb-4 flex items-center gap-4 text-sm">
      <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-muted-foreground" id="dashStatusDot"></span><span class="text-muted-foreground" id="dashStatusText">Đang tải agent status…</span></div>
      <span class="flex-1"></span>
      <span class="text-xs text-muted-foreground" id="dashNextCron"></span>
    </div>

    <!-- KPI row -->
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3" id="kpis"></div>

    <!-- Lead pipeline KPI -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
      <div class="ui-card p-5">
        <div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tổng leads tháng này</div>
        <div class="mt-2 text-3xl font-bold tracking-tight" id="kpiLeadsMonth">…</div>
        <div class="text-xs text-muted-foreground mt-1" id="kpiLeadsDelta"></div>
      </div>
      <div class="ui-card p-5">
        <div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Conversion rate (30d)</div>
        <div class="mt-2 text-3xl font-bold tracking-tight" id="kpiConvRate">…</div>
        <div class="text-xs text-muted-foreground mt-1">closed_won / total</div>
      </div>
      <div class="ui-card p-5">
        <div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Avg time-to-close</div>
        <div class="mt-2 text-3xl font-bold tracking-tight" id="kpiAvgClose">…</div>
        <div class="text-xs text-muted-foreground mt-1">new → closed_won</div>
      </div>
    </div>

    <!-- INSIGHTS — condensed current week (full version expandable) -->
    <div class="ui-card p-5 mt-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="m-0 text-sm font-semibold">💡 Insight tuần này <span class="text-xs font-normal text-muted-foreground" id="dashInsightWeek"></span></h3>
        <div class="flex items-center gap-2">
          <button id="btnDashInsightExpand" class="btn btn-ghost text-xs hidden">⤡ Mở rộng</button>
          <button id="btnDashInsightGen" class="btn btn-secondary text-xs">⚡ Generate</button>
        </div>
      </div>
      <div id="dashInsightsList" class="grid grid-cols-1 lg:grid-cols-2 gap-3"></div>
      <div id="dashInsightsFull" class="mt-4 hidden"></div>
    </div>

    <!-- TREND CHARTS -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
      <div class="ui-card p-5"><h3 class="m-0 mb-3 text-sm font-semibold">📈 Daily leads (30 ngày)</h3><canvas id="chartDaily" style="max-height:240px"></canvas></div>
      <div class="ui-card p-5"><h3 class="m-0 mb-3 text-sm font-semibold">🪜 Funnel theo stage</h3><canvas id="chartFunnel" style="max-height:240px"></canvas></div>
      <div class="ui-card p-5"><h3 class="m-0 mb-3 text-sm font-semibold">⏱ Velocity (avg ngày/stage)</h3><canvas id="chartVelocity" style="max-height:240px"></canvas></div>
      <div class="ui-card p-5"><h3 class="m-0 mb-3 text-sm font-semibold">🔥 Heatmap (giờ × thứ)</h3><div id="heatmapBox" class="overflow-auto" style="max-height:240px"></div></div>
    </div>

    <!-- Recent ETL activity -->
    <div class="ui-card p-5 mt-4">
      <h3 class="m-0 mb-3 text-sm font-semibold">⏱ Hoạt động crawl gần nhất</h3>
      <table id="recentRuns"><thead><tr><th>kind</th><th>scope</th><th>started</th><th>status</th><th class="num">rows</th><th>message</th></tr></thead><tbody></tbody></table>
    </div>
  </div>

  <!-- SETUP (gộp FB Login + Settings + ETL Runs với 3 sub-section pills) -->
  <div class="view hidden" data-view="setup">
    <div class="inline-flex rounded-md border border-border overflow-hidden mb-4" id="setupPills">
      <button data-setup-section="connection" class="setup-pill px-4 py-2 text-sm font-medium bg-accent text-foreground">🔌 Kết nối</button>
      <button data-setup-section="config"     class="setup-pill px-4 py-2 text-sm font-medium bg-card text-muted-foreground hover:bg-accent">⚙ Cấu hình</button>
      <button data-setup-section="activity"   class="setup-pill px-4 py-2 text-sm font-medium bg-card text-muted-foreground hover:bg-accent">📊 Hoạt động (ETL)</button>
    </div>
    <div id="setupBody"><span class="text-xs text-muted-foreground">Loading…</span></div>
  </div>

  <!-- ====== COMPOSE: Customer-initiated post to group ====== -->
  <div class="view hidden" data-view="compose">
    <div class="ui-card p-5 mb-4">
      <h3 class="text-base font-semibold mb-3">📝 Đăng bài mới vào group</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs text-muted-foreground mb-1">Group (chỉ group đang enabled)</label>
          <select id="composeGroup" class="form-input w-full text-sm"><option value="">— chọn group —</option></select>
        </div>
        <div>
          <label class="block text-xs text-muted-foreground mb-1">Lịch đăng (để trống = đăng ngay)</label>
          <input id="composeSchedule" type="datetime-local" class="form-input w-full text-sm">
        </div>
      </div>
      <label class="block text-xs text-muted-foreground mb-1">Nội dung bài đăng</label>
      <textarea id="composeContent" rows="6" placeholder="Viết nội dung bài đăng..." class="form-input w-full text-sm" style="font-family:inherit;"></textarea>
      <label class="block text-xs text-muted-foreground mb-1 mt-3">Image URLs (mỗi dòng 1 URL, tùy chọn, max 5)</label>
      <textarea id="composeImages" rows="3" placeholder="https://example.com/image.jpg" class="form-input w-full text-xs" style="font-family:ui-monospace,monospace;"></textarea>
      <p class="muted text-[11px] mt-1">⚠ Lần đăng đầu/nhiều bài liên tục có thể bị FB rate-limit. Agent tự detect, status sẽ hiện "rate_limited" — đợi vài giờ rồi thử lại.</p>
      <div class="flex gap-2 mt-3">
        <button id="btnComposeSubmit" class="btn btn-primary">📤 Đăng</button>
        <span id="composeMsg" class="muted text-xs self-center"></span>
      </div>
    </div>
    <div class="ui-card p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-base font-semibold m-0">Lịch sử đăng bài</h3>
        <button id="btnRefreshComposeQueue" class="btn btn-ghost text-xs">↻ Refresh</button>
      </div>
      <div id="composeQueueList"><span class="text-xs text-muted-foreground">Loading…</span></div>
    </div>
  </div>

  <!-- ====== REPLIES: AI-suggested reply queue for manual approve ====== -->
  <div class="view hidden" data-view="replies">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-base font-semibold m-0">💬 Cần duyệt reply</h3>
      <button id="btnRefreshReplies" class="btn btn-ghost text-xs">↻ Refresh</button>
    </div>
    <p class="muted text-xs mb-4">AI đọc lead + viết suggest reply. Bạn duyệt + edit nếu cần → click "Duyệt + gửi" → agent post comment lên FB. Hoặc skip để bỏ qua.</p>
    <div id="repliesQueueList"><span class="text-xs text-muted-foreground">Loading…</span></div>
  </div>

  <!-- LOGIN — content moved into Setup tab; this view is now a hidden source container that loadSetup() clones from -->
  <div class="hidden" id="srcLogin">
    <div class="panel" id="agentPanel" style="padding: 24px;">
      <h3 style="margin-top:0">🔌 Kết nối Facebook</h3>
      <div id="agentNotInstalled" class="hidden" style="padding:16px; background:#3a1c28; border-radius:6px; color:#ff9aa3;">
        <strong>Chưa cài agent trên VPS của bạn.</strong><br>
        Bạn cần SSH vào VPS rồi chạy lệnh trong welcome email để cài đặt.
      </div>
      <div id="agentInstalled" class="hidden">
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:20px;">
          <div style="background:var(--bg-card); padding:14px; border-radius:6px;">
            <div class="muted" style="font-size:11px; text-transform:uppercase;">Agent VPS</div>
            <div style="margin-top:4px;"><span id="agentStatusPill" class="pill">…</span></div>
            <div class="muted" style="font-size:11px; margin-top:6px;" id="agentVersion"></div>
          </div>
          <div style="background:var(--bg-card); padding:14px; border-radius:6px;">
            <div class="muted" style="font-size:11px; text-transform:uppercase;">Facebook session</div>
            <div style="margin-top:4px;"><span id="fbSessionPill" class="pill">…</span></div>
            <div class="muted" style="font-size:11px; margin-top:6px;" id="lastCmd"></div>
          </div>
        </div>

        <h4 style="margin:18px 0 8px">Hành động</h4>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
          <button id="btnOpenFb" class="success">📱 Mở Facebook (join groups)</button>
          <button id="btnCloseFb" class="danger" disabled>✕ Đóng Facebook</button>
          <button id="btnDiscoverNow" class="secondary" title="Quét lại danh sách groups đã join (tự đóng FB tab nếu đang mở, ~60s)">🔍 Refresh groups list</button>
          <button id="btnRunNow" class="secondary" title="Chạy crawl tất cả groups đã enable ngay (không đợi cron */15)">🚀 Chạy crawl ngay</button>
          <button id="btnResetFingerprint" class="secondary" title="Xoá khoá VPS hiện tại để license dùng được trên máy khác. Chỉ chạy khi agent đã offline >5 phút.">🔓 Reset VPS lock</button>
        </div>
        <div id="agentMsg" class="muted" style="font-size:12px; min-height:18px;"></div>

        <div id="vncReady" class="hidden" style="margin-top:18px; padding:16px; background:#1f3f2a; border-radius:6px;">
          <strong style="color:#9eecbe;">✓ Chrome đang mở trên VPS</strong><br>
          <p style="margin:8px 0;">Tab Facebook đã tự động mở. Nếu mất tab, click lại:</p>
          <a id="vncLink" href="#" target="_blank" rel="noopener" style="display:inline-block; background:#3b6ef0; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:600;">🚀 Mở lại Facebook tab</a>
        </div>

        <details style="margin-top:24px;">
          <summary class="muted" style="cursor:pointer;">Hướng dẫn chi tiết</summary>
          <ol style="font-size:13px; color:var(--text-muted); margin-top:8px;">
            <li><strong>Mở Facebook</strong> → agent khởi động Chrome trên VPS (~10s)</li>
            <li>Khi sẵn sàng, click <strong>"Mở Facebook tab mới"</strong> → tab mới hiện FB qua noVNC</li>
            <li>Trong noVNC: login FB (nếu chưa) hoặc click <strong>Groups</strong> → join groups muốn crawl</li>
            <li>Đóng tab noVNC + click <strong>"Đóng Facebook"</strong> trên dashboard</li>
            <li>Click <strong>"Refresh groups list"</strong> → groups mới xuất hiện trong tab Groups</li>
            <li>Enable groups muốn crawl → đợi 2h cron tự crawl (hoặc trigger discover)</li>
          </ol>
        </details>
      </div>
    </div>
  </div>

  <!-- DISCOVER -->
  <div class="view hidden" data-view="discover">
    <div class="row-flex" style="margin-bottom:10px">
      <button id="btnDiscStart">▶ Start discover</button>
      <button class="danger" id="btnDiscStop">■ Stop</button>
      <button class="secondary" id="btnDiscRefresh">↻ Refresh captures</button>
      <span class="muted" id="discInfo">→ browse vào group đã join, scroll feed, expand comments rồi refresh</span>
    </div>
    <div class="panel" style="padding: 8px; margin-bottom: 10px;">
      <div class="iframe-wrap" style="height: 68dvh"><iframe id="vncDiscover" src="about:blank"></iframe></div>
    </div>
    <div class="panel" style="max-height: calc(100dvh - 68dvh - 90px); display: flex; flex-direction: column;">
      <h3>📡 Captured friendly_names</h3>
      <div style="overflow:auto; flex: 1;">
        <table id="discCaps" class="fixed-table"><colgroup><col style="width:55%"><col style="width:70px"><col style="width:160px"><col style="width:140px"><col style="width:70px"></colgroup><thead><tr><th>friendly_name</th><th class="num">count</th><th>last seen</th><th>doc_id</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>

  <!-- GROUPS -->
  <div class="view hidden" data-view="groups">
    <div class="panel">
      <h3>👥 Joined groups <span class="muted" style="font-weight:400; font-size:11px;">— "scrape on" = scheduler quét group này mỗi 2 giờ.</span></h3>
      <div class="row-flex" style="margin-bottom:10px; padding:8px 10px; background:var(--bg-hover); border-radius:6px;">
        <span style="font-size:12px;">💡 Để refresh groups sau khi join thêm trên FB, vào tab <strong>FB Login</strong> → bấm <strong>🔍 Refresh groups list</strong>. Bật ON group nào bạn muốn crawl — cron 30 phút tự lo phần còn lại.</span>
      </div>
      <div id="newGroupsPanel" style="display:none; margin-bottom:10px; padding:10px 12px; background:#1f3f2a; border:1px solid #2a5a3b; border-radius:6px;">
        <div style="font-size:13px; margin-bottom:8px;">🆕 <strong>Group mới phát hiện (24h gần đây)</strong> — click để enable + backfill</div>
        <div id="newGroupsList"></div>
      </div>
      <div class="row-flex" style="margin-bottom:10px">
        <input id="groupsQ" placeholder="tìm theo tên group…" style="background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); border-radius:5px; padding:5px 10px; font-size:12px; width:260px;" />
        <select id="groupsFilter" style="background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); border-radius:5px; padding:5px 10px; font-size:12px;">
          <option value="all">tất cả</option>
          <option value="on">đang scrape</option>
          <option value="off">tắt scrape</option>
        </select>
        <button class="secondary" id="groupsReload">↻ Reload</button>
        <span class="spacer" style="flex:1"></span>
        <span class="muted" id="groupsCounter">…</span>
        <button class="secondary" id="groupsPrev">← prev</button>
        <span class="muted" id="groupsPageInfo">—</span>
        <button class="secondary" id="groupsNext">next →</button>
      </div>
      <table id="groupsTbl" class="fixed-table"><colgroup><col><col style="width:180px"><col style="width:60px"><col style="width:110px"><col style="width:160px"><col style="width:200px"></colgroup><thead><tr><th>name</th><th>id</th><th class="num">posts</th><th>scrape</th><th>last sync</th><th></th></tr></thead><tbody></tbody></table>
    </div>
  </div>

  <!-- POSTS -->
  <!-- STREAM (unified Posts + Leads + Kanban) -->
  <div class="view hidden" data-view="stream">
    <!-- Shared filter bar -->
    <div class="ui-card p-3 mb-3">
      <div class="flex flex-wrap items-center gap-2">
        <select id="streamStatus" class="form-input w-auto" title="Lọc theo trạng thái lead">
          <option value="all" selected>📋 All posts</option>
          <option value="leads">🎯 Leads only</option>
          <option value="nonleads">📰 Non-leads</option>
          <optgroup label="— By stage —" id="streamStageOpts"></optgroup>
        </select>
        <select id="streamGroup" class="form-input w-auto"><option value="">— mọi group —</option></select>
        <input id="streamQ" placeholder="tìm trong message…" class="form-input flex-1 min-w-[180px] max-w-xs" />
        <div class="inline-flex rounded-md border border-border overflow-hidden">
          <button id="streamViewList"  class="px-3 py-1.5 text-xs font-medium bg-accent text-foreground">📋 List</button>
          <button id="streamViewBoard" class="px-3 py-1.5 text-xs font-medium bg-card text-muted-foreground hover:bg-accent">🗂 Board</button>
        </div>
        <span class="flex-1"></span>
        <button class="btn btn-secondary" id="streamReload">↻ Reload</button>
        <span class="text-xs text-muted-foreground" id="streamCount"></span>
      </div>
    </div>

    <!-- KPI strip (hidden by default; shown when status=leads or by-stage) -->
    <div id="streamKpis" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4 hidden"></div>

    <!-- LIST mode -->
    <div id="streamList">
      <div class="ui-card p-5">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <select id="streamPageSize" class="form-input w-auto">
            <option value="25">25 / trang</option>
            <option value="50" selected>50 / trang</option>
            <option value="100">100 / trang</option>
            <option value="200">200 / trang</option>
          </select>
          <button class="btn btn-secondary" id="streamPrev" disabled>← Trước</button>
          <span class="text-xs text-muted-foreground" id="streamPageInfo">Trang 1</span>
          <button class="btn btn-secondary" id="streamNext" disabled>Sau →</button>
          <span class="text-xs text-muted-foreground">· Đến trang:</span>
          <input id="streamJumpPage" type="number" min="1" class="form-input" style="width:70px;">
        </div>
        <table id="streamTbl" class="fixed-table">
          <colgroup><col style="width:90px"><col style="width:60px"><col style="width:140px"><col style="width:140px"><col><col style="width:55px"><col style="width:55px"><col style="width:160px"></colgroup>
          <thead><tr><th>thời gian</th><th>loại</th><th>author</th><th>group</th><th>message</th><th class="num">❤</th><th class="num">💬</th><th>stage</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- BOARD mode (Kanban) -->
    <div id="streamBoard" class="hidden" style="display:flex; gap:10px; overflow-x:auto; padding-bottom:10px; height: calc(100dvh - 200px);"></div>
  </div>

  <!-- COMMENTS -->
  <!-- ETL — content moved into Setup tab; hidden source container -->
  <div class="hidden" id="srcEtl">
    <div id="etlBanner" class="ui-card border-l-4 border-l-primary p-4 mb-3 text-sm">
      Đang tải agent status…
    </div>
    <div class="ui-card p-5">
      <h3 class="m-0 mb-3 text-sm font-semibold">⏱ ETL runs (50 gần nhất)</h3>
      <table id="etlTbl"><thead><tr><th>id</th><th>kind</th><th>scope</th><th>started</th><th>finished</th><th>status</th><th class="num">total</th><th class="num">upsert</th><th>message</th></tr></thead><tbody></tbody></table>
    </div>
  </div>


  <!-- REPORTS -->
  <!-- SETTINGS — content moved into Setup tab; hidden source container -->
  <div class="hidden" id="srcSettings">
    <div class="ui-card p-6 max-w-3xl">
      <h3 class="m-0 mb-4 text-base font-semibold">⚙ Settings</h3>

      <div class="flex items-center justify-between mt-0 mb-1">
        <h4 class="text-sm font-semibold m-0">👤 Tài khoản FB (hiển thị trên Dashboard)</h4>
        <button id="btnFbAutoFetch" class="btn btn-secondary text-xs" title="Agent navigate facebook.com/me → đọc og:title + og:image. Chạy song song với crawl, ~10s.">🔄 Auto-fetch từ VPS</button>
      </div>
      <p class="text-xs text-muted-foreground mt-1 mb-3">Tên + avatar có thể auto-fetch (agent dùng session đã login) hoặc nhập tay. Agent sẽ tự refresh mỗi 7 ngày.</p>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div>
          <label class="block text-xs text-muted-foreground mb-1">Tên hiển thị</label>
          <input id="setFbName" type="text" placeholder="VD: Nguyễn Văn A" class="form-input w-full">
        </div>
        <div>
          <label class="block text-xs text-muted-foreground mb-1">Avatar URL</label>
          <input id="setFbAvatar" type="text" placeholder="https://..." class="form-input w-full">
        </div>
      </div>

      <h4 class="text-sm font-semibold mt-0 mb-1">📱 Telegram notification</h4>
      <p class="muted" style="font-size: 13px;">Mỗi lead mới được Gemini phân loại sẽ ping về Telegram bot của bạn để Sale tiếp cận ngay. Cần tạo bot riêng qua <code>@BotFather</code>. 💡 <i>Có thể bỏ qua bước này và setup sau — lead vẫn xem được trong tab <strong>Stream</strong>.</i></p>

      <details style="margin: 12px 0; background:var(--bg-card); padding:12px; border-radius:6px;">
        <summary style="cursor:pointer; font-weight:600;">Hướng dẫn 3 bước tạo bot</summary>
        <ol style="margin-top:10px; font-size:13px;">
          <li><strong>Tạo bot</strong>: Mở Telegram → search <code>@BotFather</code> → gửi <code>/newbot</code> → đặt tên + username → copy <b>token</b> dạng <code>123456:ABC...</code></li>
          <li><strong>Start bot</strong>: Tìm bot vừa tạo trong Telegram → bấm <b>Start</b> (gửi <code>/start</code>). Nếu muốn gửi vào group, add bot vào group + gửi 1 tin nhắn bất kỳ.</li>
          <li><strong>Paste token + click 🔍 Detect</strong> — hệ thống tự lấy chat ID từ Telegram, không cần copy thủ công.</li>
        </ol>
      </details>

      <div style="margin-top:16px;">
        <label style="display:block; font-size:12px; color:var(--text-muted); margin-bottom:4px;">Bot token</label>
        <div style="display:flex; gap:8px;">
          <input id="setTgToken" type="password" placeholder="123456:ABC-DEF..." style="flex:1; padding:8px 12px; background:var(--bg-input); border:1px solid var(--border-strong); border-radius:5px; color:var(--text); font-family:ui-monospace,monospace; font-size:13px;">
          <button id="btnTgDetect" class="secondary" style="white-space:nowrap;">🔍 Detect chat</button>
        </div>

        <div id="setTgChatBox" style="margin-top:10px; padding:10px 12px; background:var(--bg-input); border:1px solid var(--border-strong); border-radius:5px; font-size:13px; color:var(--text-muted);">
          Chưa detect — paste token rồi bấm <b>🔍 Detect chat</b>
        </div>
        <input id="setTgChat" type="hidden">

        <label style="display:block; font-size:12px; color:var(--text-muted); margin-top:14px; margin-bottom:4px;">Topics (route lead theo loại)</label>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
          <select id="setTgTopicHr" style="flex:1; background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); border-radius:5px; padding:8px 12px; font-size:13px;">
            <option value="">— Lead HR (tuyển dụng) — General —</option>
          </select>
          <select id="setTgTopicFulfill" style="flex:1; background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); border-radius:5px; padding:8px 12px; font-size:13px;">
            <option value="">— Lead fulfill (sup/xưởng) — General —</option>
          </select>
          <button id="btnTgDetectTopics" class="secondary" style="white-space:nowrap;">🔍 Detect topics</button>
        </div>
        <p class="muted" style="font-size:11px; margin:0 0 14px;">Bot phải đã được add vào group + đã thấy ≥1 message ở mỗi topic. Bấm Detect để load list.</p>

        <div style="margin-top:18px; display:flex; gap:10px;">
          <button class="success" id="btnSettingsSave">💾 Save</button>
          <button id="btnSettingsTest">📤 Send test</button>
          <span id="settingsMsg" class="muted" style="align-self:center; font-size:12px;"></span>
        </div>
      </div>

      <h4 style="margin-top:32px;">🤖 AI classifier</h4>
      <div style="margin-top:8px; display:flex; gap:12px; align-items:center;">
        <label><input type="checkbox" id="setClsEnabled"> Bật Gemini phân loại lead</label>
        <span class="muted" style="font-size:12px;">model: gemini-2.5-flash</span>
      </div>

      <div style="margin-top:14px;">
        <label class="block text-xs text-muted-foreground mb-1">Gemini API key (của bạn — để trống = dùng key hệ thống, sẽ tính chung quota của admin)</label>
        <input id="setGeminiKey" type="password" autocomplete="off" placeholder="AIzaSy… (lấy ở Google AI Studio)" class="form-input w-full" style="font-family:ui-monospace,monospace;">
        <p class="muted" style="font-size:11px; margin-top:4px;">Đặt key riêng để bill về tài khoản Google của bạn. <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" style="color:hsl(var(--primary)); text-decoration:underline;">Lấy key tại Google AI Studio</a> (free 1500 req/ngày). Cost ước tính hiển thị ở panel "💰 Chi phí Gemini AI" bên dưới.</p>
      </div>

      <h4 style="margin-top:24px;">📝 Tiêu chí lead của shop (rule cho AI)</h4>
      <p class="muted" style="font-size:13px;">Viết bằng tiếng Việt thông thường mô tả shop bạn + post NÀO được tính là lead. AI sẽ đọc rule này CÙNG với mỗi post FB để quyết định. Nếu để trống → dùng logic mặc định (7 intent cố định).</p>
      <div style="margin-bottom:8px; display:flex; align-items:center; gap:8px;">
        <label style="font-size:12px; color:var(--text-muted);">🎯 Chọn template:</label>
        <select id="leadRuleTemplate" class="form-input" style="font-size:12px; padding:4px 8px; width:auto;">
          <option value="">-- Tự viết --</option>
          <option value="pod">In áo POD / Print on demand</option>
          <option value="mmo">MMO / Dropshipping</option>
          <option value="bds">Bất động sản</option>
          <option value="tuyendung">Tuyển dụng / Headhunt</option>
          <option value="dichvu">Dịch vụ in ấn / sản xuất</option>
          <option value="spa">Spa / Làm đẹp</option>
          <option value="fnb">F&amp;B / Nhà hàng</option>
        </select>
        <span class="muted" style="font-size:11px;">→ tự fill textarea (chỉ khi đang trống)</span>
      </div>
      <textarea id="setLeadRules" rows="8" placeholder="Chọn template ở trên hoặc viết mô tả ngắn về shop bạn + post nào được tính là lead..." style="width:100%; min-height:150px; padding:10px 12px; background:var(--bg-input); border:1px solid var(--border-strong); border-radius:5px; color:var(--text); font-family:inherit; font-size:13px; line-height:1.5; resize:vertical;"></textarea>
      <div style="margin-top:8px; display:flex; gap:24px; align-items:center; flex-wrap:wrap;">
        <label style="font-size:12px; color:var(--text-muted);">Min confidence:
          <input id="setMinConf" type="range" min="0" max="100" step="5" style="vertical-align:middle; margin-left:6px;">
          <span id="setMinConfV" style="font-family:ui-monospace,monospace; color:hsl(var(--primary)); margin-left:6px;">0%</span>
        </label>
        <label style="font-size:12px; color:var(--text-muted);">Chỉ lead trong:
          <input id="setMaxAge" type="number" min="0" max="365" style="width:60px; padding:4px 8px; margin-left:6px; background:var(--bg-input); border:1px solid var(--border-strong); border-radius:4px; color:var(--text); font-family:ui-monospace,monospace; font-size:13px;">
          <span class="muted" style="font-size:12px; margin-left:4px;">ngày gần nhất (0 = không giới hạn)</span>
        </label>
        <label style="font-size:12px; color:var(--text-muted);">Chống trùng (dedup):
          <input id="setDedupDays" type="number" min="0" max="90" style="width:60px; padding:4px 8px; margin-left:6px; background:var(--bg-input); border:1px solid var(--border-strong); border-radius:4px; color:var(--text); font-family:ui-monospace,monospace; font-size:13px;">
          <span class="muted" style="font-size:12px; margin-left:4px;">ngày (0 = tắt)</span>
        </label>
      </div>
      <p class="muted" style="font-size:11px; margin-top:6px;">Posts cũ hơn N ngày sẽ bị skip — không gọi Gemini, không tạo lead. Tránh tạo lead từ bài đăng cũ.</p>
      <p class="muted" style="font-size:11px; margin-top:4px;">Chống trùng: nếu cùng 1 tác giả đăng lại bài giống hệt trong N ngày, chỉ tính 1 lead (bỏ qua bài đăng lại — không bắn Telegram). Tránh spam khi nhà tuyển dụng đăng lại liên tục.</p>

      <!-- ─── Auto-reply (AI suggest comment) ──────────────────────────── -->
      <div class="mt-6 pt-5 border-t border-border">
        <div class="flex items-center justify-between mb-1">
          <h4 class="text-sm font-semibold m-0">💬 Auto-reply (AI gợi ý comment)</h4>
          <label class="flex items-center gap-2 text-xs cursor-pointer">
            <input id="setAutoReplyEnabled" type="checkbox" class="form-checkbox">
            <span>Bật AI suggest</span>
          </label>
        </div>
        <p class="muted text-[11px] mb-3">Khi bật, mỗi lead mới được Gemini soạn 1 reply mẫu → bạn duyệt + chỉnh sửa ở tab <strong>💬 Duyệt reply</strong> trước khi gửi lên FB. KHÔNG tự động gửi (chống ban acc).</p>
        <label class="block text-xs muted mb-1">Intent áp dụng (cách bằng dấu phẩy, để trống = tất cả lead)</label>
        <input id="setAutoReplyIntents" type="text" placeholder="vd: hỏi giá, tìm sup, request_quote" class="form-input w-full text-sm mb-2">
        <label class="block text-xs muted mb-1">Mô tả shop cho AI (tùy chọn, fallback dùng "Lead Rules" ở trên)</label>
        <textarea id="setAutoReplyShopContext" rows="3" placeholder="VD: Shop chuyên cung cấp sỉ thời trang nữ, giao Toàn quốc, freeship đơn ≥ 500k..." class="form-input w-full text-sm" style="font-family:inherit;"></textarea>
        <div class="grid grid-cols-2 gap-3 mt-3">
          <label class="text-xs muted">Max posts / ngày<input id="setMaxPostsPerDay" type="number" min="0" max="500" class="form-input w-full text-sm mt-1"></label>
          <label class="text-xs muted">Max replies / ngày<input id="setMaxRepliesPerDay" type="number" min="0" max="500" class="form-input w-full text-sm mt-1"></label>
        </div>
      </div>

      <!-- ─── Block list (suppress lead alerts per company / author) ───── -->
      <div class="mt-6 pt-5 border-t border-border">
        <div class="flex items-center justify-between mb-1">
          <h4 class="text-sm font-semibold m-0">🚫 Blocklist — bỏ qua lead từ công ty / tác giả này</h4>
          <button id="btnReloadBlocklist" class="btn btn-ghost text-xs">↻</button>
        </div>
        <p class="muted text-[11px] mb-3">Tap <code>🚫 Block</code> trong Telegram → tự thêm vào đây. Hoặc thêm thủ công:</p>
        <div class="flex gap-2 mb-3">
          <select id="blkScope" class="form-input text-sm" style="width:120px;">
            <option value="org">Tên cty</option>
            <option value="author">FB author_id</option>
          </select>
          <input id="blkPattern" type="text" placeholder="vd: HUTATO" class="form-input flex-1 text-sm">
          <button id="btnAddBlock" class="btn btn-secondary text-sm">+ Add</button>
        </div>
        <div id="blocklistTable"><span class="muted text-xs">Loading…</span></div>
      </div>

      <div style="margin-top:18px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="success" id="btnSettingsSave2">💾 Save rules + classifier</button>
        <button class="danger" id="btnReclassifyAll" title="Xoá tất cả lead hiện tại + re-classify mọi post với rule mới (tốn Gemini quota)">🔄 Re-classify all posts</button>
        <span id="settingsMsg2" class="muted" style="align-self:center; font-size:12px;"></span>
      </div>

      <!-- ─── Gemini cost & token usage ─────────────────────────────────── -->
      <div class="mt-8 pt-6 border-t border-border">
        <div class="flex items-center justify-between mb-2">
          <h4 class="text-sm font-semibold m-0">💰 Chi phí Gemini AI</h4>
          <div class="flex items-center gap-2">
            <select id="geminiUsageDays" class="form-input text-xs" style="padding:4px 8px;">
              <option value="7">7 ngày</option>
              <option value="14" selected>14 ngày</option>
              <option value="30">30 ngày</option>
              <option value="90">90 ngày</option>
            </select>
            <button id="btnReloadGeminiUsage" class="btn btn-secondary text-xs">🔄</button>
          </div>
        </div>
        <p class="text-xs text-muted-foreground mb-3">Số token + chi phí ước tính cho từng ngày. Lưu mỗi lần gọi Gemini (classifier lead + comment analyzer). Giá có thể chỉnh qua env <code>GEMINI_PRICE_INPUT_USD_PER_1M</code> / <code>GEMINI_PRICE_OUTPUT_USD_PER_1M</code> / <code>GEMINI_USD_VND</code>.</p>
        <div id="geminiUsageTotals" class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3"></div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs" id="geminiUsageTable">
            <thead><tr class="text-left text-muted-foreground border-b border-border">
              <th class="py-2 pr-3">Ngày</th>
              <th class="py-2 pr-3 text-right">Calls</th>
              <th class="py-2 pr-3 text-right">Input tok</th>
              <th class="py-2 pr-3 text-right">Output tok</th>
              <th class="py-2 pr-3 text-right">Tổng tok</th>
              <th class="py-2 pr-3 text-right">USD</th>
              <th class="py-2 pr-3 text-right">VND</th>
            </tr></thead>
            <tbody id="geminiUsageBody"><tr><td colspan="7" class="py-3 text-muted-foreground">Loading…</td></tr></tbody>
          </table>
        </div>
        <div class="mt-4">
          <h5 class="text-xs font-semibold text-muted-foreground uppercase mb-2">Theo mục đích</h5>
          <table class="w-full text-xs" id="geminiPurposeTable">
            <thead><tr class="text-left text-muted-foreground border-b border-border">
              <th class="py-2 pr-3">Purpose</th>
              <th class="py-2 pr-3 text-right">Calls</th>
              <th class="py-2 pr-3 text-right">Input</th>
              <th class="py-2 pr-3 text-right">Output</th>
              <th class="py-2 pr-3 text-right">VND</th>
            </tr></thead>
            <tbody id="geminiPurposeBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</main>

<div id="toasts"></div>

<aside class="row-detail" id="detailPanel">
  <button class="closebtn" onclick="closeDetail()">×</button>
  <h3 id="detailTitle">Detail</h3>
  <div id="detailBody"></div>
</aside>

<script>
const NOVNC_URL = ${JSON.stringify(NOVNC_URL)};

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function fmtTime(t){ if(!t) return '—'; const d = new Date(t); return d.toLocaleString(); }
function fmtAgo(t){
  if(!t) return '—';
  const s = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
  if(s < 60) return s + 's';
  if(s < 3600) return Math.floor(s/60) + 'm';
  if(s < 86400) return Math.floor(s/3600) + 'h';
  return Math.floor(s/86400) + 'd';
}
function fmtN(n){ return n == null ? '—' : Number(n).toLocaleString('en-US'); }

function toast(msg, type='', ms=3500){
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function api(path, body){
  const opts = { method: 'POST' };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  let r, j;
  try { r = await fetch(path, opts); }
  catch (e) { toast('Network error: ' + e.message, 'error', 5000); return null; }
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok) {
    toast((j && (j.message || j.error)) || ('HTTP ' + r.status + ' ' + path), 'error', 5000);
    return null;
  }
  return j;
}
async function getJson(path){
  try {
    const r = await fetch(path);
    return await r.json();
  } catch (e) {
    toast('GET fail: ' + path, 'error');
    return null;
  }
}

// ── Tab routing
const TITLES = { dashboard: 'Dashboard', discover: 'Discover XHR', groups: 'Groups', stream: 'Stream', compose: 'Đăng bài', replies: 'Duyệt reply', setup: 'Setup' };
function switchView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== name));
  document.querySelectorAll('nav#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
  $('topTitle').textContent = TITLES[name] ?? name;
  location.hash = name;
  // Always poll agent status (every 10s) so Groups tab buttons + FB Login pills
  // reflect the live run state regardless of which tab user is on.
  if (!window._globalPollStarted) { window._globalPollStarted = true; startAgentPolling(); }
  // lazy-load iframe for discover (legacy cloud-side noVNC)
  if (name === 'discover' && $('vncDiscover').src === 'about:blank') $('vncDiscover').src = NOVNC_URL;
  if (name === 'discover') loadCaptures();
  if (name === 'groups')   loadGroups();
  if (name === 'stream')   loadStream();
  if (name === 'setup')    loadSetup();
  if (name === 'compose')  loadCompose();
  if (name === 'replies')  loadReplies();
  if (name === 'dashboard') { loadDashboard(); loadReports(); loadDashInsights(); loadDashStatus(); }
}
document.querySelectorAll('nav#nav a').forEach(a => a.addEventListener('click', () => switchView(a.dataset.view)));

// ── Dashboard
function card(label, value, sub){
  return '<div class="ui-card p-5">' +
    '<div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">' + esc(label) + '</div>' +
    '<div class="mt-2 text-2xl font-bold tracking-tight">' + esc(value) + '</div>' +
    (sub ? '<div class="text-xs text-muted-foreground mt-1">' + esc(sub) + '</div>' : '') +
  '</div>';
}

/**
 * Session health card — answers "is my FB scraping still working?".
 * Buckets session age into Fresh (<14d) / Stable (14-45d) / Sắp hết (>45d).
 * FB cookies typically expire ~60-90 days after last use, so 45d is a useful
 * yellow flag for sale to plan re-login on noVNC before downtime.
 */
function sessionCard(sess){
  if (!sess) {
    return '<div class="ui-card p-5">' +
      '<div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tài khoản Facebook</div>' +
      '<div class="mt-2 text-base font-semibold text-destructive">⚠ Chưa đăng nhập</div>' +
      '<div class="text-xs text-muted-foreground mt-1">Vào tab <strong>FB Login</strong> để đăng nhập</div>' +
    '</div>';
  }
  const ageDays = sess.created_at ? Math.floor((Date.now() - new Date(sess.created_at).getTime()) / 86_400_000) : 0;
  let pill, hint;
  if (ageDays < 14)      { pill = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-500">● Fresh</span>'; hint = 'Cookies còn fresh — crawl ổn định'; }
  else if (ageDays < 45) { pill = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/15 text-blue-500">● Stable</span>'; hint = 'Hoạt động bình thường'; }
  else                   { pill = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-500">● Sắp hết hạn</span>'; hint = 'Nên re-login để tránh gián đoạn'; }
  const cuser      = String(sess.c_user || '');
  const profileUrl = cuser ? 'https://www.facebook.com/' + cuser : null;
  const hasName    = !!sess.display_name;
  const name       = sess.display_name || ('FB ID …' + cuser.slice(-6));
  // Avatar: only use the user-set URL. FB's public Graph picture endpoint
  // returns a silhouette placeholder for personal accounts (auth-walled), so
  // an initials circle looks better as the default.
  const initials   = hasName
    ? (sess.display_name.split(/\\s+/).map(w => w[0]).slice(-2).join('').toUpperCase() || 'FB')
    : 'FB';
  const avatarEl   = sess.avatar_url
    ? '<img src="' + esc(sess.avatar_url) + '" class="w-10 h-10 rounded-full object-cover bg-muted" alt="avatar" onerror="this.replaceWith(Object.assign(document.createElement(\\'div\\'),{className:\\'w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold\\',innerText:\\'' + esc(initials) + '\\'}))" />'
    : '<div class="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold">' + esc(initials) + '</div>';
  const cta = hasName ? '' :
    '<a href="#settings" class="block text-[10px] text-primary hover:underline mt-1">→ Nhập tên + avatar trong Settings</a>';
  return '<div class="ui-card p-5">' +
    '<div class="flex items-center justify-between mb-3"><div class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tài khoản Facebook</div>' + pill + '</div>' +
    '<div class="flex items-center gap-3">' +
      avatarEl +
      '<div class="min-w-0 flex-1">' +
        '<div class="text-sm font-semibold truncate">' +
          (profileUrl ? '<a href="' + esc(profileUrl) + '" target="_blank" class="text-foreground hover:text-primary">' + esc(name) + ' ↗</a>' : esc(name)) +
        '</div>' +
        '<div class="text-[11px] text-muted-foreground truncate">Login ' + ageDays + ' ngày trước · ' + esc(hint) + '</div>' +
        cta +
      '</div>' +
    '</div>' +
  '</div>';
}
async function loadDashboard(){
  const s = await getJson('/api/dashboard/stats');
  if (!s) return;
  const en = s.counts.groups_enabled ?? 0;
  const jo = s.counts.groups ?? 0;
  $('kpis').innerHTML = [
    sessionCard(s.session),
    card('Groups đang crawl', en + ' / ' + jo, en === 0 ? 'Chưa bật group nào — vào tab Groups bật ON' : 'đang crawl ' + en + ' / ' + jo + ' đã join'),
    card('Posts đã thu thập', fmtN(s.counts.posts), 'tổng lifetime'),
    card('Comments đã thu thập', fmtN(s.counts.comments), 'tổng lifetime'),
    card('Đồng bộ gần nhất', s.last_sync_at ? fmtAgo(s.last_sync_at) + ' trước' : '—', s.last_sync_at ? fmtTime(s.last_sync_at) : 'chưa có data'),
  ].join('');

  $('recentRuns').querySelector('tbody').innerHTML = (s.recent_runs ?? []).map(r =>
    '<tr><td><code>' + esc(r.kind) + '</code></td>' +
    '<td>' + esc(r.scope ?? '') + '</td>' +
    '<td class="muted">' + esc(fmtTime(r.started_at)) + '</td>' +
    '<td class="s-' + esc(r.status) + '">' + esc(r.status) + '</td>' +
    '<td class="num">' + fmtN(r.rows_upserted) + '</td>' +
    '<td class="muted">' + esc(String(r.message ?? '').slice(0, 200)) + '</td></tr>'
  ).join('') || '<tr><td colspan="6" class="muted">no runs yet</td></tr>';

  // sidebar
  $('sideSession').textContent = s.session ? s.session.c_user : '—';
  $('sideSession').className = 'pill ' + (s.session ? 'live' : 'warn');
  $('sideSync').textContent = s.last_sync_at ? fmtAgo(s.last_sync_at) + ' ago' : '—';
  $('sideCron').textContent = '*/30 min';
}

// ── Agent-controlled FB Login (Phase B3 UX)
// _agentState is a shared mini-store any tab can read (e.g. Groups tab uses
// run_in_flight to disable per-group crawl buttons).
window._agentState = { run_in_flight: false, agent_online: false };
let _agentPollTimer = null;
async function loadAgentStatus() {
  try {
    const r = await fetch('/api/dashboard/agent/status', { credentials: 'same-origin' });
    const j = await r.json();
    if (!j.installed) {
      $('agentNotInstalled') && $('agentNotInstalled').classList.remove('hidden');
      $('agentInstalled')    && $('agentInstalled').classList.add('hidden');
      window._agentState.installed = false;
      return;
    }
    window._agentState.installed     = true;
    window._agentState.agent_online  = j.online_status === 'online';
    window._agentState.run_in_flight = j.run_in_flight === true;
    window._agentState.run_started_at = j.run_started_at;
    // Notify Groups tab (if mounted) to refresh button disabled state.
    if (typeof updateGroupsButtonsState === 'function') updateGroupsButtonsState();
    $('agentNotInstalled') && $('agentNotInstalled').classList.add('hidden');
    $('agentInstalled')    && $('agentInstalled').classList.remove('hidden');

    // Agent status pill
    const onlineCls = j.online_status === 'online' ? 'pill-ok' : (j.online_status === 'stale' ? 'pill-warn' : 'pill-err');
    const onlineTxt = j.online_status === 'online' ? '🟢 online' : (j.online_status === 'stale' ? '🟡 stale' : '🔴 offline');
    $('agentStatusPill').className = 'pill ' + onlineCls;
    $('agentStatusPill').textContent = onlineTxt;
    $('agentVersion').textContent = 'v' + (j.agent_version || '?') + ' · last seen ' + (j.last_seen_at ? new Date(j.last_seen_at).toLocaleTimeString('vi-VN') : '—');

    // FB session pill
    if (j.fb_session_alive) {
      $('fbSessionPill').className = 'pill pill-ok';
      $('fbSessionPill').textContent = '🟢 Đã login';
    } else {
      $('fbSessionPill').className = 'pill pill-warn';
      $('fbSessionPill').textContent = '⚠ Chưa login';
    }
    $('lastCmd').textContent = j.last_command ? ('Lệnh gần nhất: ' + j.last_command + ' @ ' + (j.last_command_at ? new Date(j.last_command_at).toLocaleTimeString('vi-VN') : '?')) : '';

    // Pending command queue state (FIFO) + crawl in-flight banner
    const pendingList = (j.pending_commands || []).map(p => p.cmd);
    let msg = '';
    if (j.online_status !== 'online') {
      // Agent not heartbeating — clear next step instead of fall-through to idle/queue.
      msg = j.online_status === 'stale'
        ? '🟡 <strong>Agent stale</strong> — heartbeat trễ. Đợi 5-10 phút, nếu chuyển OFFLINE thì SSH vào VPS: <code>systemctl restart auto-facebook-agent</code>'
        : '🔴 <strong>Agent OFFLINE</strong> — chưa kết nối tới cloud. ' + (j.last_seen_at
            ? 'Heartbeat cuối: ' + new Date(j.last_seen_at).toLocaleTimeString('vi-VN') + '. Check VPS còn chạy không.'
            : 'Chạy install.sh trên VPS chưa? Lệnh cài có trong email welcome.');
    } else if (j.run_in_flight) {
      const startedAgo = j.run_started_at
        ? Math.round((Date.now() - new Date(j.run_started_at).getTime()) / 1000)
        : 0;
      const mins = Math.floor(startedAgo / 60);
      const ago  = mins > 0 ? mins + 'p ' + (startedAgo % 60) + 's' : startedAgo + 's';
      let progress = '';
      if (j.run_groups_total && j.run_groups_total > 0) {
        const pct = Math.round((j.run_groups_done / j.run_groups_total) * 100);
        const curr = j.run_current_group ? ' · đang xử lý <code>' + esc(j.run_current_group) + '</code>' : '';
        progress = ' · <strong>' + j.run_groups_done + '/' + j.run_groups_total + '</strong> groups (' + pct + '%)' + curr;
      }
      msg = '🔄 <strong>Đang crawl (' + (j.run_mode || '?') + ')</strong> — bắt đầu ' + ago + ' trước' + progress + '. Lệnh khác sẽ vào queue.';
    } else if (pendingList.length) {
      // Queue waiting → agent will pick up at next heartbeat (≤60s), NOT at
      // next cron. Highlight this so user doesn't think they have to wait.
      msg = '⏳ <strong>Lệnh trong queue sẽ chạy trong ≤60s</strong> (heartbeat kế): <code>[' + pendingList.join(' → ') + ']</code>';
    } else {
      // Cron incr = "*/30 * * * *" → next :00 hoặc :30.
      const now = new Date();
      const next = new Date(now);
      next.setSeconds(0, 0);
      next.setMinutes(now.getMinutes() < 30 ? 30 : 60);
      const diffMin = Math.max(1, Math.round((next.getTime() - now.getTime()) / 60000));
      msg = '✅ Agent idle. Crawl tự động tiếp theo: <strong>' + next.toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'}) + '</strong> (trong ' + diffMin + ' phút).';
    }
    $('agentMsg').innerHTML = msg;

    // Update button states — disable everything that triggers a crawl while one in-flight.
    // Also disable Open FB while crawl in-flight (Chrome profile lock collision).
    const hasOpenQueued  = pendingList.includes('open_login');
    const hasCloseQueued = pendingList.includes('close_login');
    const hasDiscoverQueued = pendingList.includes('discover_now') || pendingList.includes('discover_groups_only');
    $('btnOpenFb').disabled  = j.login_active || hasOpenQueued || j.run_in_flight;
    if (j.run_in_flight && !j.login_active) {
      $('btnOpenFb').title = 'Crawl đang chạy — đợi xong rồi mở Facebook (tránh conflict chrome-profile)';
    } else {
      $('btnOpenFb').title = '';
    }
    $('btnCloseFb').disabled = !j.login_active || hasCloseQueued;
    if ($('btnDiscoverNow')) {
      $('btnDiscoverNow').disabled = j.run_in_flight || hasDiscoverQueued;
      $('btnDiscoverNow').textContent = j.run_in_flight
        ? '🔄 Crawl đang chạy…'
        : (hasDiscoverQueued ? '⏳ Đã queue, đợi…' : '🔍 Refresh groups list');
    }
    if ($('btnRunNow')) {
      $('btnRunNow').disabled = j.run_in_flight;
      $('btnRunNow').textContent = j.run_in_flight ? '🔄 Crawl đang chạy…' : '🚀 Chạy crawl ngay';
    }

    if (j.login_active && j.vnc_public_url) {
      $('vncReady').classList.remove('hidden');
      $('vncLink').href = j.vnc_public_url;
    } else {
      $('vncReady').classList.add('hidden');
    }
  } catch (e) {
    console.warn('agent status failed', e);
  }
}

async function sendAgentCmd(cmd) {
  $('agentMsg').textContent = '⏳ Đang gửi lệnh "' + cmd + '"…';
  try {
    const r = await fetch('/api/dashboard/agent/command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
    const j = await r.json();
    if (j.ok) { toast('Đã gửi lệnh — agent sẽ thực hiện trong ~60s', 'success'); }
    else { toast('Lỗi: ' + (j.message || j.error), 'error'); }
  } catch (e) { toast('Lỗi mạng: ' + e.message, 'error'); }
  loadAgentStatus();
}

$('btnOpenFb').onclick = () => {
  // Open bridge page in NEW TAB immediately. Page handles command + polling +
  // auto-redirect to noVNC. User just clicks once and waits in the new tab.
  window.open('/fb-launcher', '_blank', 'noopener,noreferrer');
};
$('btnCloseFb').onclick    = () => sendAgentCmd('close_login');
$('btnDiscoverNow').onclick = () => sendAgentCmd('discover_groups_only');
$('btnRunNow') && ($('btnRunNow').onclick = () => sendAgentCmd('crawl_now_incr'));
$('btnResetFingerprint') && ($('btnResetFingerprint').onclick = async () => {
  if (!confirm('Reset khoá VPS? Lần heartbeat tiếp theo từ bất kỳ máy nào sẽ trở thành máy được lock-in mới.\\n\\nChỉ chạy nếu bạn đang chuyển VPS hoặc đổi hostname.')) return;
  const r = await fetch('/api/agent/reset-fingerprint', { method:'POST', credentials:'same-origin' });
  const j = await r.json();
  if (j.ok) toast('✓ Khoá VPS đã reset (cũ: ' + (j.previous_hostname || '—') + ')', 'success');
  else      toast('Lỗi: ' + (j.message || j.error), 'error');
});

// Poll agent status every 8s globally (so buttons across tabs reflect live state).
function startAgentPolling() {
  loadAgentStatus();
  if (_agentPollTimer) clearInterval(_agentPollTimer);
  _agentPollTimer = setInterval(loadAgentStatus, 8000);
}
function stopAgentPolling() {
  if (_agentPollTimer) { clearInterval(_agentPollTimer); _agentPollTimer = null; }
}

// ── Discover
$('btnDiscStart').onclick = async () => {
  const r = await api('/api/discover/start', { startUrl: 'https://www.facebook.com/groups/feed/' });
  if (r) { $('vncDiscover').src = NOVNC_URL; toast('Discover started: ' + r.runId, 'success'); loadCaptures(); }
};
$('btnDiscStop').onclick = async () => {
  const r = await api('/api/discover/stop');
  if (r) toast('Discover stopped');
  loadCaptures();
};
$('btnDiscRefresh').onclick = () => loadCaptures();

async function loadCaptures(){
  const j = await getJson('/api/discover/captures');
  if (!j) return;
  $('sideDisc').textContent = j.running ? 'recording' : 'idle';
  $('sideDisc').className = 'pill ' + (j.running ? 'live' : '');
  $('discInfo').textContent = j.running
    ? 'Recording → ' + j.runId + '. Browse vào group, scroll, expand comments.'
    : 'Idle. Click "Start discover" để bắt đầu.';
  $('discCaps').querySelector('tbody').innerHTML = (j.rows ?? []).map(r =>
    '<tr><td><code>' + esc(r.friendly_name) + '</code></td>' +
    '<td class="num">' + fmtN(r.n) + '</td>' +
    '<td class="muted">' + esc(fmtTime(r.last_seen)) + '</td>' +
    '<td>' + esc('') + '</td>' +
    '<td><button class="secondary" onclick="viewCapture(' + r.sample_id + ')">view</button></td></tr>'
  ).join('') || '<tr><td colspan="5" class="muted">no captures yet — start discover + browse FB</td></tr>';
}

async function viewCapture(id){
  const j = await getJson('/api/discover/captures/' + id);
  if (!j?.ok) return;
  const r = j.row;
  $('detailTitle').textContent = (r.friendly_name || '(no name)') + '  ·  ' + (r.method ?? '') + ' ' + r.status;
  $('detailBody').innerHTML =
    '<dl>' +
    '<dt>URL</dt><dd>' + esc(r.url) + '</dd>' +
    '<dt>doc_id</dt><dd>' + esc(r.doc_id ?? '(none)') + '</dd>' +
    '<dt>request_body</dt><dd>' + esc((r.request_body ?? '').slice(0, 8000)) + '</dd>' +
    '<dt>response_body (first 8KB)</dt><dd>' + esc((r.response_body ?? '').slice(0, 8000)) + '</dd>' +
    '</dl>';
  $('detailPanel').classList.add('open');
}
function closeDetail(){ $('detailPanel').classList.remove('open'); }
window.viewCapture = viewCapture;
window.closeDetail = closeDetail;

// ── Groups
const groupsState = { offset: 0, limit: 50 };
async function loadRefreshInfo(){
  const j = await getJson('/api/groups/refresh-info');
  if (!j) return;
  const r = j.last;
  if (!r) {
    $('groupsRefreshInfo').textContent = 'chưa refresh lần nào';
  } else if (r.status === 'running') {
    $('groupsRefreshInfo').innerHTML = '<span class="s-running">đang chạy từ ' + esc(fmtAgo(r.started_at)) + ' trước…</span>';
  } else {
    $('groupsRefreshInfo').textContent = 'lần cuối: ' + fmtAgo(r.finished_at) + ' trước (' + (r.rows_upserted ?? '?') + ' groups)';
  }
}

async function loadNewGroups(){
  const j = await getJson('/api/groups/new');
  if (!j) return;
  const list = j.rows ?? [];
  const panel = $('newGroupsPanel');
  if (list.length === 0) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  $('newGroupsList').innerHTML = list.map(r =>
    '<div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-top:1px solid #2a5a3b;">' +
      '<span style="flex:1; font-size:13px;">' + esc(r.name || r.group_id) + '</span>' +
      '<span class="muted" style="font-size:11px;">' + esc(fmtAgo(r.first_seen_at)) + ' trước</span>' +
      '<button class="js-crawl-btn success" onclick="enableAndBackfill(\\'' + esc(r.group_id) + '\\', this)" style="white-space:nowrap;">🚀 Enable + Backfill</button>' +
    '</div>'
  ).join('');
}
async function enableAndBackfill(gid, btn){
  // Phase B: cloud-side ETL is dead. Just enable the group; agent picks it up
  // on next cron tick (or trigger discover_now from FB Login tab for immediate).
  btn.disabled = true; btn.textContent = '⏳ enabling…';
  await fetch('/api/groups/' + gid, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({enabled: true}) });
  toast('Enabled — agent sẽ crawl ở lần tick tiếp theo. Click "🔍 Refresh groups list" trên tab FB Login để crawl ngay.', 'success', 6000);
  loadGroups();
}
window.enableAndBackfill = enableAndBackfill;
async function loadGroups(){
  loadRefreshInfo();
  loadNewGroups();
  const q = $('groupsQ').value.trim();
  const filter = $('groupsFilter').value;
  const params = new URLSearchParams({ limit: String(groupsState.limit), offset: String(groupsState.offset) });
  if (q)      params.set('q', q);
  if (filter !== 'all') params.set('enabled', filter);
  const g = await getJson('/api/groups?' + params.toString());
  if (!g) return;
  const counts = await getJson('/api/dashboard/group-post-counts').catch(() => null);
  const cmap = {};
  if (counts?.rows) for (const r of counts.rows) cmap[r.group_id] = Number(r.n);
  $('groupsTbl').querySelector('tbody').innerHTML = (g.rows ?? []).map(r =>
    '<tr><td>' + esc(r.name ?? '(?)') + '</td>' +
    '<td><code>' + esc(r.group_id) + '</code></td>' +
    '<td class="num">' + fmtN(cmap[r.group_id] ?? 0) + '</td>' +
    '<td>' + (r.enabled ? '<span class="pill live">scrape on</span>' : '<span class="pill">scrape off</span>') + '</td>' +
    '<td class="muted">' + esc(fmtTime(r.updated_at)) + '</td>' +
    '<td><button class="secondary" onclick="toggleGroup(\\'' + esc(r.group_id) + '\\', ' + (!r.enabled) + ')">' + (r.enabled ? 'turn off' : 'turn on') + '</button></td></tr>'
  ).join('') || '<tr><td colspan="6" class="muted">không có group nào khớp — thử bỏ search hoặc đổi filter</td></tr>';

  // counter + paging
  const t = g.totals ?? {}; const p = g.paging ?? {};
  $('groupsCounter').textContent = (t.enabled ?? 0) + ' / ' + (t.total ?? 0) + ' enabled · filter: ' + (p.total ?? 0) + ' kết quả';
  const from = (p.total ?? 0) === 0 ? 0 : p.offset + 1;
  const to   = Math.min((p.total ?? 0), p.offset + p.limit);
  $('groupsPageInfo').textContent = from + '–' + to;
  $('groupsPrev').disabled = p.offset <= 0;
  $('groupsNext').disabled = (p.offset + p.limit) >= (p.total ?? 0);
  $('sideSession') && updateSidebarGroupCount(t.enabled, t.total);
}
function updateSidebarGroupCount(enabled, total){
  // optional — update sidebar pill if present (no-op if element missing)
  const el = document.getElementById('sideGroups');
  if (el) el.textContent = (enabled ?? 0) + '/' + (total ?? 0);
}
$('groupsReload').onclick = () => { groupsState.offset = 0; loadGroups(); };
$('groupsFilter').onchange = () => { groupsState.offset = 0; loadGroups(); };
$('groupsQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { groupsState.offset = 0; loadGroups(); } });
$('groupsPrev').onclick = () => { groupsState.offset = Math.max(0, groupsState.offset - groupsState.limit); loadGroups(); };
$('groupsNext').onclick = () => { groupsState.offset += groupsState.limit; loadGroups(); };
async function toggleGroup(id, v){ await fetch('/api/groups/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({enabled: v}) }); loadGroups(); }
window.toggleGroup = toggleGroup;

// Disable all crawl-triggering buttons when agent has a run in-flight; shows
// banner so user understands click is queued behind. Hooked from loadAgentStatus.
function updateGroupsButtonsState() {
  const inFlight = window._agentState && window._agentState.run_in_flight;
  document.querySelectorAll('.js-crawl-btn').forEach((b) => {
    if (inFlight) {
      b.disabled = true;
      if (!b.dataset.origText) b.dataset.origText = b.textContent;
      b.textContent = '⏸ Đang crawl…';
    } else {
      b.disabled = false;
      if (b.dataset.origText) { b.textContent = b.dataset.origText; delete b.dataset.origText; }
    }
  });
}
window.updateGroupsButtonsState = updateGroupsButtonsState;


// ── Lead enums (stage labels + intent labels) — shared by Stream view
let LEAD_ENUMS = null;
const LEAD_ENUMS_FALLBACK = { stages: [], intents: [] };
async function ensureLeadEnums(){
  if (LEAD_ENUMS) return LEAD_ENUMS;
  const j = await getJson('/api/leads/enums');
  LEAD_ENUMS = (j && Array.isArray(j.stages)) ? j : LEAD_ENUMS_FALLBACK;
  return LEAD_ENUMS;
}

const INTENT_COLOR = { request_quote: '#9eecbe', question: 'hsl(var(--primary))', complaint: '#f3c87a', showcase: 'var(--text-2)', spam: '#ef6b6b', seeding: '#9b6bd6', other: 'var(--text-muted)' };

function intentPill(intent){
  if (!intent) return '<span class="muted">—</span>';
  const label = LEAD_ENUMS?.intents.find(i => i.value === intent)?.label ?? intent;
  return '<span class="pill" style="background:#1f3f2a; color:' + (INTENT_COLOR[intent] || 'var(--text-2)') + ';">' + esc(label) + '</span>';
}
function stageLabel(stage){ return LEAD_ENUMS?.stages.find(s => s.value === stage)?.label ?? stage; }


async function updateLeadStageInline(sel){
  const id = sel.dataset.lead;
  const newStage = sel.value;
  const prev = sel.dataset.prev || sel.querySelector('option[selected]')?.value;
  sel.disabled = true;
  try {
    const r = await fetch('/api/leads/' + id, {
      method: 'PATCH', credentials: 'same-origin',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ stage: newStage }),
    });
    const j = await r.json();
    if (j.ok) {
      sel.dataset.prev = newStage;
      toast('Đã chuyển stage → ' + (LEAD_ENUMS.stages.find(s => s.value === newStage)?.label ?? newStage), 'success');
      if (typeof refreshStreamKpis === 'function' && typeof isStreamLeadFilter === 'function' && isStreamLeadFilter()) refreshStreamKpis();
    } else {
      sel.value = prev;
      toast('Lỗi: ' + (j.message || j.error || '?'), 'error');
    }
  } catch (e) {
    sel.value = prev;
    toast('Lỗi mạng: ' + e.message, 'error');
  } finally {
    sel.disabled = false;
  }
}
window.updateLeadStageInline = updateLeadStageInline;

function extractPhotosFromRaw(raw, fallback){
  const urls = new Set();
  const push = (u) => { if (typeof u === 'string' && u.startsWith('http')) urls.add(u); };
  if (fallback && /\\.(jpg|jpeg|png|webp|gif)(\\?|$)/i.test(fallback)) push(fallback);
  const attachments = Array.isArray(raw?.attachments) ? raw.attachments : [];
  for (const a of attachments) {
    push(a?.styles?.attachment?.media?.photo_image?.uri);
    push(a?.styles?.attachment?.media?.image?.uri);
    push(a?.media?.photo_image?.uri);
    push(a?.media?.image?.uri);
    // Album posts (StoryAttachmentAlbumStyleRenderer) — multiple photos
    const albumNodes = a?.styles?.attachment?.all_subattachments?.nodes ?? a?.all_subattachments?.nodes ?? [];
    for (const n of albumNodes) {
      push(n?.media?.image?.uri);
      push(n?.media?.photo_image?.uri);
    }
    // Legacy subattachments array
    for (const sub of (a?.subattachments ?? [])) {
      push(sub?.media?.image?.uri);
      push(sub?.media?.photo_image?.uri);
    }
  }
  return Array.from(urls);
}

// ── Stream tab (unified Posts + Leads + Kanban) ─────────────────────
const STREAM_STAGES = [
  ['new',            'Chưa tiếp cận',   '#3b6ef0'],
  ['contacted',      'Đã liên hệ',       '#5e7be8'],
  ['info_sent',      'Đã gửi thông tin', 'hsl(var(--primary))'],
  ['negotiating',    'Đang deal giá',    '#fbbf24'],
  ['sample_sent',    'Đã gửi mẫu',       '#fbbf24'],
  ['awaiting_reply', 'Chờ phản hồi',     '#fbbf24'],
  ['topup_1',        'Topup lần 01',     '#a78bfa'],
  ['first_order',    'Lên đơn đầu',      '#a78bfa'],
  ['topup_2',        'Topup lần 02',     '#a78bfa'],
  ['shipped_sg',     'Chuyển SG',        '#10b981'],
  ['closed_won',     'Chốt thành công',  '#22c55e'],
  ['closed_lost',    'Mất lead',         '#ef4444'],
];

const streamState = { view: 'list', status: 'all', page: 1, group: '', q: '', _initialised: false };

function syncStreamHash(){
  const p = new URLSearchParams();
  if (streamState.view   !== 'list') p.set('view',   streamState.view);
  if (streamState.status !== 'all')  p.set('status', streamState.status);
  if (streamState.page   !== 1)      p.set('page',   String(streamState.page));
  if (streamState.group)             p.set('group',  streamState.group);
  if (streamState.q)                 p.set('q',      streamState.q);
  const qs = p.toString();
  const newHash = qs ? 'stream?' + qs : 'stream';
  if (location.hash.slice(1) !== newHash) history.replaceState(null, '', '#' + newHash);
}

function isStreamLeadFilter(){
  return streamState.status === 'leads' || STREAM_STAGES.some(([v]) => v === streamState.status);
}

async function refreshStreamKpis(){
  if (!$('streamKpis')) return;
  const stats = await getJson('/api/leads/stats');
  if (!stats) return;
  const c = stats.stages || {};
  $('streamKpis').innerHTML = [
    card('Mới (chưa tiếp cận)', fmtN(c.new ?? 0), ''),
    card('Đang xử lý', fmtN((c.contacted||0)+(c.info_sent||0)+(c.negotiating||0)+(c.sample_sent||0)+(c.awaiting_reply||0)), 'contacted → awaiting_reply'),
    card('Đã đặt hàng', fmtN((c.topup_1||0)+(c.first_order||0)+(c.topup_2||0)+(c.shipped_sg||0)), 'topup → ship'),
    card('Chốt thành công', fmtN(c.closed_won ?? 0), ''),
    card('Mất lead', fmtN(c.closed_lost ?? 0), ''),
    card('Lead 24h gần', fmtN(stats.recent_24h ?? 0), ''),
  ].join('');
}

async function loadStream(){
  await ensureLeadEnums();
  if (!streamState._initialised) {
    const sel = $('streamGroup');
    const g = await getJson('/api/posts/groups');
    if (g?.rows) for (const r of g.rows) {
      const o = document.createElement('option');
      o.value = r.group_id;
      o.textContent = (r.name || r.group_id) + '  (' + r.n_posts + ')';
      sel.appendChild(o);
    }
    const stageOpts = $('streamStageOpts');
    if (stageOpts && LEAD_ENUMS?.stages) {
      stageOpts.innerHTML = LEAD_ENUMS.stages.map(s => '<option value="' + esc(s.value) + '">📍 ' + esc(s.label) + '</option>').join('');
    }
    const h = parseHash();
    if (h.view === 'stream') {
      streamState.view   = h.params.get('view')   || 'list';
      streamState.status = h.params.get('status') || 'all';
      streamState.page   = Number(h.params.get('page')) || 1;
      streamState.group  = h.params.get('group')  || '';
      streamState.q      = h.params.get('q')      || '';
    }
    $('streamStatus').value   = streamState.status;
    $('streamGroup').value    = streamState.group;
    $('streamQ').value        = streamState.q;
    setStreamViewButtons();
    streamState._initialised = true;
  } else {
    streamState.status = $('streamStatus').value;
    streamState.group  = $('streamGroup').value;
    streamState.q      = $('streamQ').value.trim();
  }

  if (isStreamLeadFilter()) { $('streamKpis').classList.remove('hidden'); await refreshStreamKpis(); }
  else                      { $('streamKpis').classList.add('hidden'); }

  syncStreamHash();
  if (streamState.view === 'board') return loadStreamBoard();
  return loadStreamList();
}

function setStreamViewButtons(){
  const a = $('streamViewList'), b = $('streamViewBoard');
  if (!a || !b) return;
  if (streamState.view === 'board') {
    a.className = 'px-3 py-1.5 text-xs font-medium bg-card text-muted-foreground hover:bg-accent';
    b.className = 'px-3 py-1.5 text-xs font-medium bg-accent text-foreground';
    $('streamList').classList.add('hidden');
    $('streamBoard').classList.remove('hidden');
  } else {
    a.className = 'px-3 py-1.5 text-xs font-medium bg-accent text-foreground';
    b.className = 'px-3 py-1.5 text-xs font-medium bg-card text-muted-foreground hover:bg-accent';
    $('streamList').classList.remove('hidden');
    $('streamBoard').classList.add('hidden');
  }
}

async function loadStreamList(){
  const pageSize = Number($('streamPageSize').value || '50');
  const offset = (streamState.page - 1) * pageSize;
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (streamState.group)            params.set('group_id', streamState.group);
  if (streamState.q)                params.set('q', streamState.q);
  if (streamState.status !== 'all') params.set('status', streamState.status);

  const j = await getJson('/api/stream?' + params.toString());
  if (!j) return;
  const total = j.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (streamState.page > totalPages) { streamState.page = totalPages; return loadStreamList(); }
  const start = total === 0 ? 0 : offset + 1;
  const end   = Math.min(offset + pageSize, total);
  $('streamCount').textContent = total + ' tổng · hiển thị ' + start + '-' + end;
  $('streamPageInfo').textContent = 'Trang ' + streamState.page + ' / ' + totalPages;
  $('streamPrev').disabled = streamState.page <= 1;
  $('streamNext').disabled = streamState.page >= totalPages;
  $('streamJumpPage').max = String(totalPages);
  $('streamJumpPage').value = String(streamState.page);

  $('streamTbl').querySelector('tbody').innerHTML = (j.rows ?? []).map(r => {
    const ago = r.detected_at ? fmtAgo(r.detected_at) + ' trước' : (r.created_time ? fmtAgo(r.created_time) + ' trước' : '—');
    const msg = (r.message ?? '').replace(/\\s+/g, ' ').slice(0, 200);
    const displayName = r.author_name || (r.author_id ? String(r.author_id) : '?');
    const truncated   = displayName.length > 22 ? displayName.slice(0, 22) + '…' : displayName;
    const linkTarget  = r.is_anonymous_post
      ? r.permalink
      : (r.author_profile || (r.author_id ? 'https://www.facebook.com/' + r.author_id : null));
    const authorInner = r.is_anonymous_post ? ('🎭 ' + esc(truncated)) : esc(truncated);
    const author = linkTarget
      ? '<a href="' + esc(linkTarget) + '" target="_blank" title="' + esc(displayName) + '" onclick="event.stopPropagation()" style="color:hsl(var(--primary)); text-decoration:none;">' + authorInner + '</a>'
      : '<span title="' + esc(displayName) + '">' + authorInner + '</span>';
    const group = (r.group_name || r.group_id || '').slice(0, 20);
    const typeCell = r.lead_id
      ? '<span class="pill" style="background:rgba(34,197,94,0.15); color:#22c55e;">🎯</span>'
      : '<span class="pill muted">—</span>';
    const stageCell = r.lead_id
      ? '<select class="js-lead-stage" data-lead="' + r.lead_id + '" onclick="event.stopPropagation()" onchange="updateLeadStageInline(this)" style="background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); border-radius:4px; padding:4px 6px; font-size:12px; max-width:160px;">' +
          LEAD_ENUMS.stages.map(s => '<option value="' + esc(s.value) + '"' + (s.value === r.stage ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') +
        '</select>'
      : (r.permalink ? '<a href="' + esc(r.permalink) + '" target="_blank" onclick="event.stopPropagation()" style="color:hsl(var(--primary)); font-size:12px;">↗ FB</a>' : '—');
    return '<tr style="cursor:pointer" onclick="viewItem(\\'' + esc(r.post_id) + '\\', ' + (r.lead_id || 'null') + ')">' +
      '<td class="muted" title="' + esc(fmtTime(r.created_time)) + '">' + esc(ago) + '</td>' +
      '<td>' + typeCell + '</td>' +
      '<td class="muted">' + author + '</td>' +
      '<td><span title="' + esc(r.group_id || '') + '">' + esc(group) + '</span></td>' +
      '<td>' + esc(msg) + '</td>' +
      '<td class="num">' + fmtN(r.reaction_count) + '</td>' +
      '<td class="num">' + fmtN(r.comment_count) + '</td>' +
      '<td>' + stageCell + '</td>' +
    '</tr>';
  }).join('') || '<tr><td colspan="8" class="muted">không có post nào — thử Reload hoặc đổi filter</td></tr>';
}

async function loadStreamBoard(){
  // Board requires all leads. Force status=leads if currently all/nonleads.
  if (streamState.status === 'all' || streamState.status === 'nonleads') {
    streamState.status = 'leads';
    $('streamStatus').value = 'leads';
    $('streamKpis').classList.remove('hidden');
    syncStreamHash();
  }
  const params = new URLSearchParams({ limit: '2000', status: streamState.status });
  if (streamState.group) params.set('group_id', streamState.group);
  if (streamState.q)     params.set('q', streamState.q);

  const j = await getJson('/api/stream?' + params.toString());
  if (!j) return;
  const rows = (j.rows ?? []).filter(r => r.lead_id);
  $('streamCount').textContent = rows.length + ' leads' + (j.total > rows.length ? ' (cap 2000)' : '');

  const board = $('streamBoard');
  board.innerHTML = STREAM_STAGES.map(([key, label, color]) =>
    '<div class="kan-col" data-stage="' + key + '" style="min-width:280px; max-width:280px; background:var(--bg-card); border:1px solid var(--border); border-radius:8px; display:flex; flex-direction:column;">' +
      '<div style="padding:10px 12px; border-bottom:2px solid ' + color + '; flex-shrink:0;">' +
        '<div style="font-size:13px; font-weight:600; color:' + color + ';">' + esc(label) + '</div>' +
        '<div class="muted" style="font-size:11px; margin-top:2px;"><span class="kan-count">…</span> leads</div>' +
      '</div>' +
      '<div class="kan-body" data-stage="' + key + '" style="flex:1; overflow-y:auto; padding:8px; min-height:0;"></div>' +
    '</div>'
  ).join('');

  const byStage = {};
  STREAM_STAGES.forEach(([k]) => byStage[k] = []);
  rows.forEach(r => { if (byStage[r.stage]) byStage[r.stage].push(r); });
  STREAM_STAGES.forEach(([k]) => {
    const body = board.querySelector('.kan-body[data-stage="' + k + '"]');
    const col  = board.querySelector('.kan-col[data-stage="' + k + '"] .kan-count');
    body.innerHTML = byStage[k].map(renderStreamCard).join('');
    col.textContent = byStage[k].length;
  });

  if (typeof Sortable !== 'undefined') {
    board.querySelectorAll('.kan-body').forEach(col => {
      new Sortable(col, {
        group: 'stream', animation: 140, ghostClass: 'kan-ghost',
        onEnd: async (evt) => {
          const card = evt.item;
          const leadId = card.dataset.leadId;
          const oldStage = evt.from.dataset.stage;
          const newStage = evt.to.dataset.stage;
          if (oldStage === newStage) return;
          recalcStreamCounts(board);
          try {
            const r = await fetch('/api/leads/' + leadId, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ stage: newStage }) });
            const j = await r.json();
            if (!j.ok) throw new Error(j.message || j.error || 'lưu fail');
            toast('Đã chuyển → ' + (LEAD_ENUMS.stages.find(s => s.value === newStage)?.label ?? newStage), 'success');
            if (isStreamLeadFilter()) refreshStreamKpis();
          } catch (e) {
            toast('Lỗi: ' + e.message, 'error');
            const oldBody = board.querySelector('.kan-body[data-stage="' + oldStage + '"]');
            if (oldBody) oldBody.appendChild(card);
            recalcStreamCounts(board);
          }
        },
      });
    });
  }
}

function renderStreamCard(r) {
  const intentLabels = {request_quote:'Hỏi giá',question:'Câu hỏi',complaint:'Phàn nàn',showcase:'Khoe',spam:'Spam',seeding:'Seeding',other:'Khác'};
  const intentColors = {request_quote:'#22c55e',question:'#3b6ef0',complaint:'#ef4444',showcase:'#a78bfa',spam:'#6b7280',seeding:'#fbbf24',other:'#6b7280'};
  const intColor = intentColors[r.intent] || '#6b7280';
  const displayName = r.author_name || (r.author_id ? String(r.author_id) : '?');
  const truncated   = displayName.length > 28 ? displayName.slice(0, 28) + '…' : displayName;
  const linkTarget  = r.is_anonymous_post
    ? r.permalink
    : (r.author_profile || (r.author_id ? 'https://www.facebook.com/' + r.author_id : null));
  const authorInner = (r.is_anonymous_post ? '🎭 ' : '👤 ') + esc(truncated);
  const author = linkTarget
    ? '<a href="' + esc(linkTarget) + '" target="_blank" title="' + esc(displayName) + '" onclick="event.stopPropagation()" style="color:hsl(var(--primary)); text-decoration:none;">' + authorInner + '</a>'
    : '<span title="' + esc(displayName) + '">' + authorInner + '</span>';
  const ago = r.detected_at ? fmtAgo(r.detected_at) + ' trước' : '';
  const msg = (r.message ?? '').replace(/\\s+/g, ' ').slice(0, 140);
  const group = (r.group_name || '').slice(0, 28);
  return '<div class="kan-card" data-lead-id="' + r.lead_id + '" onclick="viewItem(\\'' + esc(r.post_id) + '\\', ' + r.lead_id + ')" style="background:var(--bg-input); border:1px solid var(--border); border-radius:6px; padding:10px; margin-bottom:8px; cursor:grab; font-size:12px;">' +
    '<div style="display:flex; justify-content:space-between; gap:6px; margin-bottom:6px;">' +
      '<span style="background:' + intColor + '22; color:' + intColor + '; padding:2px 7px; border-radius:99px; font-size:11px; font-weight:600;">' + (intentLabels[r.intent] || r.intent || '?') + '</span>' +
      '<span class="muted" style="font-size:10px;">' + esc(ago) + '</span>' +
    '</div>' +
    '<div style="margin-bottom:6px;">' + author + '</div>' +
    '<div style="color:var(--text-2); line-height:1.4;">' + esc(msg) + '</div>' +
    '<div class="muted" style="font-size:10px; margin-top:6px; padding-top:6px; border-top:1px solid var(--border);">📍 ' + esc(group) + '</div>' +
  '</div>';
}

function recalcStreamCounts(board) {
  STREAM_STAGES.forEach(([k]) => {
    const body = board.querySelector('.kan-body[data-stage="' + k + '"]');
    const cnt  = board.querySelector('.kan-col[data-stage="' + k + '"] .kan-count');
    cnt.textContent = body.children.length;
  });
}

// Unified detail panel: works for posts WITH or WITHOUT a lead.
async function viewItem(postId, leadIdOpt){
  await ensureLeadEnums();
  const postJ = await getJson('/api/posts/' + encodeURIComponent(postId));
  if (!postJ?.ok) { toast('Post không tồn tại', 'error'); return; }
  const r = postJ.row;
  const comments = postJ.comments ?? [];

  // Resolve lead_id: prefer caller-provided (from row data), else probe by post_id.
  let lead = null, history = [];
  let leadId = leadIdOpt;
  if (!leadId) {
    try {
      const probe = await getJson('/api/stream?post_id=' + encodeURIComponent(postId) + '&limit=1');
      const found = probe?.rows?.[0];
      if (found?.lead_id) leadId = found.lead_id;
    } catch {}
  }
  if (leadId) {
    const detailJ = await getJson('/api/leads/' + leadId);
    if (detailJ?.ok) { lead = detailJ.lead; history = detailJ.history ?? []; }
  }

  const actor       = r.raw?.actors?.[0] ?? null;
  const authorName    = actor?.name ?? null;
  const authorProfile = actor?.url  ?? null;
  const isAnon = r.is_anonymous_post === true
    || actor?.__typename === 'GroupAnonAuthorProfile'
    || actor?.__typename === 'GroupAnonymousAuthor'
    || actor?.__isActor  === 'GroupAnonAuthorProfile'
    || (actor && actor.id && !authorProfile);
  const displayName = authorName || (r.author_id ? 'User ' + String(r.author_id) : 'Unknown');
  const clickUrl    = isAnon ? r.permalink : authorProfile;
  const authorTxt   = (isAnon ? '🎭 ' : '') + esc(displayName);
  const authorLinked = clickUrl
    ? '<a href="' + esc(clickUrl) + '" target="_blank" style="color:var(--text); text-decoration:none;">' + authorTxt + '  <span style="color:hsl(var(--primary)); font-size:11px;">↗</span></a>'
    : authorTxt;
  const initials  = isAnon ? '🎭' : (authorName ? authorName.split(/\\s+/).map(w => w[0]).slice(-2).join('').toUpperCase() : String(r.author_id || '?').slice(-2));
  const photoUrls = extractPhotosFromRaw(r.raw, r.attachment_url);
  const ago       = r.created_time ? fmtAgo(r.created_time) + ' trước' : '—';
  const groupTxt  = r.group_name || r.group_id || '?';
  const msgHtml   = esc(r.message || '').replace(/\\n/g, '<br>');
  const reactN    = Number(r.reaction_count) || 0;
  const commN     = Number(r.comment_count)  || 0;
  const shareN    = Number(r.share_count)    || 0;
  const ibUrl     = (!isAnon) ? (authorProfile || (r.author_id ? 'https://www.facebook.com/' + String(r.author_id) : null)) : null;

  $('detailTitle').textContent = lead ? ('🎯 Lead #' + lead.lead_id) : ('📰 Post ' + r.post_id);

  let html = '';
  html += '<div style="background:var(--bg-card); border:1px solid var(--border-strong); border-radius:8px; overflow:hidden;">';
  html += '<div style="display:flex; align-items:center; gap:10px; padding:12px 14px;">';
  html += '<div style="width:40px; height:40px; border-radius:50%; background:' + (isAnon ? '#3d3a4f' : '#3b6ef0') + '; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:13px; flex-shrink:0;">' + esc(initials) + '</div>';
  html += '<div style="flex:1; min-width:0;"><div style="font-weight:600; font-size:14px;">' + authorLinked + '</div>';
  html += '<div class="muted" style="font-size:12px;">đăng trong <strong>' + esc(groupTxt) + '</strong> · ' + esc(ago) + (r.created_time ? ' · <span title="' + esc(fmtTime(r.created_time)) + '">🕒</span>' : '') + '</div></div>';
  html += (r.permalink ? '<a href="' + esc(r.permalink) + '" target="_blank" class="secondary" style="padding:6px 10px; border-radius:5px; color:hsl(var(--primary)); font-size:12px; text-decoration:none; flex-shrink:0;">↗ Mở FB</a>' : '') + '</div>';
  html += '<div style="padding:0 14px 14px; font-size:14px; line-height:1.55; white-space:pre-wrap; max-height:400px; overflow-y:auto;">' + msgHtml + '</div>';
  html += (photoUrls.length === 0 ? '' :
     photoUrls.length === 1
       ? '<a href="' + esc(photoUrls[0]) + '" target="_blank"><img src="' + esc(photoUrls[0]) + '" loading="lazy" style="display:block; width:100%; max-height:400px; object-fit:cover; border-top:1px solid var(--border-strong);" alt="post photo" /></a>'
       : '<div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:2px; border-top:1px solid var(--border-strong); background:var(--bg-input);">' +
           photoUrls.map(u => '<a href="' + esc(u) + '" target="_blank"><img src="' + esc(u) + '" loading="lazy" style="display:block; width:100%; height:200px; object-fit:cover;" alt="post photo" /></a>').join('') +
         '</div>');
  html += '<div style="display:flex; gap:18px; padding:10px 14px; border-top:1px solid var(--border-strong); font-size:13px; color:var(--text-muted);">';
  html += '<span>❤️ ' + fmtN(reactN) + '</span><span>💬 ' + fmtN(commN) + '</span><span>↗ ' + fmtN(shareN) + '</span>';
  html += (ibUrl ? '<a href="' + esc(ibUrl) + '" target="_blank" style="margin-left:auto; color:#9eecbe;">👤 Mở profile (để IB)</a>' : '<span class="muted" style="margin-left:auto;">👤 Profile ẩn (anonymous post)</span>');
  html += '</div></div>';

  if (lead) {
    const confPct = Math.round((Number(lead.intent_confidence) || 0) * 100);
    const entitiesStr = lead.intent_entities ? Object.entries(lead.intent_entities).filter(([_,v]) => v).map(([k,v]) => '<strong>' + esc(k) + ':</strong> ' + esc(String(v))).join(' · ') : '';
    const stageOpts = LEAD_ENUMS.stages.map(s => '<option value="' + esc(s.value) + '"' + (s.value === lead.stage ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('');
    html += '<details open style="margin-top:14px; background:var(--bg-card); border-radius:6px; padding:10px 12px;">' +
      '<summary style="cursor:pointer; font-size:13px;">🤖 <strong>AI:</strong> ' + intentPill(lead.intent) + '  <span class="muted">' + confPct + '%</span></summary>' +
      '<div style="margin-top:8px; font-size:12px;"><div style="font-style:italic; color:var(--text-2);">' + esc(lead.intent_reason || '—') + '</div>' +
        (entitiesStr ? '<div style="margin-top:6px; font-size:11px;">' + entitiesStr + '</div>' : '') +
      '</div></details>';
    html += '<div style="margin-top:14px; background:var(--bg-card); border-radius:6px; padding:12px;">' +
      '<div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">' +
        '<label style="font-size:12px; color:var(--text-muted);">Stage:</label>' +
        '<select id="leadStageEdit" style="background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); padding:5px 8px; border-radius:5px; flex:1;">' + stageOpts + '</select>' +
        '<button class="success" onclick="saveItemStage(' + lead.lead_id + ', \\'' + esc(postId) + '\\')">💾 Save</button>' +
      '</div>' +
      '<textarea id="leadNoteEdit" rows="2" style="width:100%; background:var(--bg-input); color:var(--text); border:1px solid var(--border-strong); border-radius:5px; padding:6px 8px; font-family:inherit; font-size:12px; box-sizing:border-box;" placeholder="thêm note…">' + esc(lead.note || '') + '</textarea>' +
      '<button class="secondary" style="margin-top:6px; font-size:12px;" onclick="addItemNote(' + lead.lead_id + ', \\'' + esc(postId) + '\\')">+ Thêm note vào history</button>' +
    '</div>';
    if (history.length) {
      html += '<div style="margin-top:14px;"><div style="font-size:13px; font-weight:600; margin-bottom:6px;">📜 History</div>' +
        '<div style="max-height:200px; overflow-y:auto; background:var(--bg-card); border-radius:6px; padding:10px 12px;">' +
          history.map(h =>
            '<div style="padding:5px 0; border-top:1px solid var(--border); font-size:11px;">' +
              '<span class="muted">' + esc(fmtTime(h.created_at)) + ' · ' + esc(h.actor || 'system') + '</span>' +
              ' <strong>' + esc(h.action) + '</strong>' +
              (h.from_value || h.to_value ? ': ' + esc(h.from_value || '∅') + ' → ' + esc(h.to_value || '∅') : '') +
              (h.note ? '<div style="margin-top:3px; font-style:italic;">' + esc(h.note) + '</div>' : '') +
            '</div>'
          ).join('') +
        '</div></div>';
    }
  } else {
    html += '<div style="margin-top:14px; padding:10px 12px; background:var(--bg-card); border-radius:6px; font-size:12px; color:var(--text-muted);">' +
      'Post này chưa được Gemini classify thành lead. Có thể không match rule của shop hoặc post cũ hơn lead_max_age_days.' +
      '</div>';
  }

  const commentsHtml = comments.length === 0
    ? '<span class="muted" style="font-size:12px;">chưa scrape comments</span>'
    : comments.map(c => {
        const cIsAnon = c.author_typename === 'GroupAnonAuthorProfile' || c.author_typename === 'GroupAnonymousAuthor' || (c.author_id && !c.author_profile && !c.author_name);
        const cName   = c.author_name || (c.author_id ? 'User ' + c.author_id : '?');
        const cTrunc  = cName.length > 40 ? cName.slice(0, 40) + '…' : cName;
        const cIcon   = cIsAnon ? '🎭 ' : '';
        const cLink   = cIsAnon ? null : (c.author_profile || (c.author_id ? 'https://www.facebook.com/' + c.author_id : null));
        const cAuthor = cLink
          ? '<a href="' + esc(cLink) + '" target="_blank" rel="noopener" title="' + esc(cName) + '" style="color:var(--text); text-decoration:none; font-weight:600;">' + cIcon + esc(cTrunc) + ' <span style="color:hsl(var(--primary)); font-size:10px;">↗</span></a>'
          : '<strong title="' + esc(cName) + '">' + cIcon + esc(cTrunc) + '</strong>';
        const cReact = c.reaction_count ? ' · ❤ ' + fmtN(c.reaction_count) : '';
        return '<div style="padding:8px 0; border-top:1px solid var(--border); font-size:12px;">' +
                  cAuthor + ' <span class="muted">· ' + esc(fmtAgo(c.created_time)) + ' trước' + cReact + '</span>' +
                  '<div style="white-space:pre-wrap; margin-top:2px;">' + esc(c.message || '') + '</div>' +
               '</div>';
      }).join('');
  html += '<div style="margin-top:14px;"><div style="font-size:13px; font-weight:600; margin-bottom:6px;">💬 Comments (' + comments.length + ' đã scrape / ' + fmtN(commN) + ' trên FB)</div>' +
    '<div style="max-height:300px; overflow-y:auto; background:var(--bg-card); border-radius:6px; padding:10px 12px;">' + commentsHtml + '</div></div>';

  $('detailBody').innerHTML = html;
  $('detailPanel').classList.add('open');
}

async function saveItemStage(leadId, postId){
  const stage = $('leadStageEdit').value;
  const note  = $('leadNoteEdit').value;
  const r = await fetch('/api/leads/' + leadId, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ stage, note }) });
  const j = await r.json();
  if (j.ok) { toast('Đã lưu', 'success'); viewItem(postId); loadStream(); }
  else      toast('Lưu fail', 'error');
}
async function addItemNote(leadId, postId){
  const note = $('leadNoteEdit').value.trim();
  if (!note) { toast('Note rỗng', 'error'); return; }
  const r = await api('/api/leads/' + leadId + '/note', { note });
  if (r?.ok) { toast('Đã thêm note vào history', 'success'); $('leadNoteEdit').value=''; viewItem(postId); }
}

window.viewItem = viewItem;
window.saveItemStage = saveItemStage;
window.addItemNote = addItemNote;
// Back-compat shims so any old onclick=viewPost(...) / viewLead(...) still works
window.viewPost = viewItem;
window.viewLead = async (leadId) => {
  const j = await getJson('/api/leads/' + leadId);
  if (j?.ok && j.lead) viewItem(j.lead.post_id);
};

// Stream event handlers (attach only if elements exist)
if ($('streamStatus')) {
  $('streamStatus').onchange  = () => { streamState.page = 1; loadStream(); };
  $('streamGroup').onchange   = () => { streamState.page = 1; loadStream(); };
  $('streamQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { streamState.page = 1; loadStream(); } });
  $('streamReload').onclick   = () => loadStream();
  $('streamPageSize').onchange= () => { streamState.page = 1; loadStreamList(); };
  $('streamPrev').onclick     = () => { streamState.page = Math.max(1, streamState.page - 1); loadStreamList(); syncStreamHash(); };
  $('streamNext').onclick     = () => { streamState.page = streamState.page + 1; loadStreamList(); syncStreamHash(); };
  $('streamJumpPage').onchange= (e) => { streamState.page = Math.max(1, Number(e.target.value) || 1); loadStreamList(); syncStreamHash(); };
  $('streamViewList').onclick = () => { streamState.view = 'list'; setStreamViewButtons(); loadStream(); };
  $('streamViewBoard').onclick= () => { streamState.view = 'board'; setStreamViewButtons(); loadStream(); };
}

// ── ETL
function buildAgentBannerHtml(j){
  if (!j || !j.installed) return '⚠️ Chưa cài agent trên VPS.';
  if (j.run_in_flight) {
    const startedAgo = j.run_started_at
      ? Math.round((Date.now() - new Date(j.run_started_at).getTime()) / 1000) : 0;
    const mins = Math.floor(startedAgo / 60);
    const ago  = mins > 0 ? mins + 'p ' + (startedAgo % 60) + 's' : startedAgo + 's';
    if (j.run_mode === 'discover') {
      return '🔍 <strong>Đang quét lại danh sách groups</strong> — bắt đầu ' + ago + ' trước (~30-60s).';
    }
    let progress = '';
    if (j.run_groups_total && j.run_groups_total > 0) {
      const pct = Math.round((j.run_groups_done / j.run_groups_total) * 100);
      const curr = j.run_current_group ? ' · đang xử lý <code>' + esc(j.run_current_group) + '</code>' : '';
      progress = ' · <strong>' + j.run_groups_done + '/' + j.run_groups_total + '</strong> groups (' + pct + '%)' + curr;
    }
    return '🔄 <strong>Đang crawl (' + (j.run_mode || '?') + ')</strong> — bắt đầu ' + ago + ' trước' + progress + '.';
  }
  // Cron incr = "*/30 * * * *" → next tick is the next :00 or :30 mark.
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(now.getMinutes() < 30 ? 30 : 60);
  const diffMin = Math.max(1, Math.round((next.getTime() - now.getTime()) / 60000));
  return '✅ Agent idle. Crawl tự động tiếp theo: <strong>' + next.toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'}) + '</strong> (trong ' + diffMin + ' phút).';
}

// ── Setup tab (gộp Connection + Config + Activity, mỗi cái là sub-section) ──
// HTML của 3 view gốc (FB Login, Settings, ETL Runs) đã đổi từ data-view= sang
// id="srcLogin/srcSettings/srcEtl". loadSetup() di chuyển nodes (DOM appendChild)
// giữa source containers và #setupBody. Move-nodes (vs innerHTML clone) giữ
// nguyên event listeners + form values đã typed.
const SETUP_SRC_MAP = { connection: 'srcLogin', config: 'srcSettings', activity: 'srcEtl' };

function setSetupSection(name){
  const body = $('setupBody');
  if (!body) return;
  // 1. Move current section nodes back to its source
  const cur = body.dataset.section;
  if (cur && SETUP_SRC_MAP[cur]) {
    const src = $(SETUP_SRC_MAP[cur]);
    if (src) while (body.firstChild) src.appendChild(body.firstChild);
  } else {
    // First entry: clear placeholder text
    body.innerHTML = '';
  }
  // 2. Move new section nodes from source to body
  const newSrc = $(SETUP_SRC_MAP[name]);
  if (newSrc) while (newSrc.firstChild) body.appendChild(newSrc.firstChild);
  body.dataset.section = name;
  // 3. Update pill styles
  document.querySelectorAll('.setup-pill').forEach(p => {
    if (p.dataset.setupSection === name) {
      p.className = 'setup-pill px-4 py-2 text-sm font-medium bg-accent text-foreground';
    } else {
      p.className = 'setup-pill px-4 py-2 text-sm font-medium bg-card text-muted-foreground hover:bg-accent';
    }
  });
  // 4. Trigger the section's loader
  if (name === 'connection' && typeof loadAgentStatus === 'function') loadAgentStatus();
  if (name === 'config'     && typeof loadSettings    === 'function') loadSettings();
  if (name === 'activity'   && typeof loadEtl         === 'function') loadEtl();
  // 5. Sync URL hash
  const newHash = name === 'connection' ? 'setup' : 'setup?section=' + name;
  if (location.hash.slice(1) !== newHash) history.replaceState(null, '', '#' + newHash);
}

async function loadSetup(){
  const h = parseHash();
  const section = h.params.get('section') || 'connection';
  setSetupSection(section);
}

// ── COMPOSE: post to FB group ─────────────────────────────────────────
async function loadCompose(){
  // 1) Populate group dropdown from enabled groups
  try {
    const g = await getJson('/api/groups?limit=300');
    const sel = $('composeGroup');
    if (sel && g?.rows) {
      const opts = (g.rows || [])
        .filter(r => r.enabled !== false)
        .map(r => '<option value="' + esc(r.group_id) + '">' + esc(r.name || r.group_id) + '</option>')
        .join('');
      sel.innerHTML = '<option value="">— chọn group —</option>' + opts;
    }
  } catch (e) {}
  // 2) Wire submit handler (idempotent)
  const btn = $('btnComposeSubmit');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.onclick = async () => {
      const gid = $('composeGroup').value.trim();
      const content = $('composeContent').value.trim();
      const imgs = $('composeImages').value.trim().split(/\\n+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
      const sch = $('composeSchedule').value;
      const msg = $('composeMsg');
      msg.className = 'muted text-xs self-center';
      if (!gid) { msg.textContent = '✗ Chọn group đã'; return; }
      if (content.length < 5) { msg.textContent = '✗ Nội dung quá ngắn'; return; }
      btn.disabled = true; msg.textContent = '⏳ Đang gửi…';
      try {
        const r = await fetch('/api/posts/compose', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ group_id: gid, content, image_urls: imgs, schedule_at: sch || null }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || 'lỗi');
        msg.textContent = '✓ Đã queue (id ' + j.id + ')';
        $('composeContent').value = '';
        $('composeImages').value = '';
        loadComposeQueue();
      } catch (e) {
        msg.textContent = '✗ ' + (e?.message ?? e);
      } finally { btn.disabled = false; }
    };
  }
  const rfb = $('btnRefreshComposeQueue');
  if (rfb && !rfb._wired) { rfb._wired = true; rfb.onclick = loadComposeQueue; }
  // 3) Render queue
  loadComposeQueue();
}

async function loadComposeQueue(){
  const list = $('composeQueueList');
  if (!list) return;
  try {
    const j = await getJson('/api/posts/queue?limit=50');
    const rows = j?.rows || [];
    if (!rows.length) { list.innerHTML = '<span class="muted text-xs">Chưa có bài nào.</span>'; return; }
    const pillClass = (s) => ({
      pending: 'bg-amber-100 text-amber-900',
      dispatched: 'bg-blue-100 text-blue-900',
      posted: 'bg-emerald-100 text-emerald-900',
      pending_review: 'bg-purple-100 text-purple-900',
      rate_limited: 'bg-orange-100 text-orange-900',
      failed: 'bg-red-100 text-red-900',
      cancelled: 'bg-gray-100 text-gray-700',
    })[s] || 'bg-gray-100 text-gray-700';
    list.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-muted-foreground border-b border-border">'
      + '<th class="py-2 pr-3">ID</th><th class="py-2 pr-3">Group</th><th class="py-2 pr-3">Nội dung</th>'
      + '<th class="py-2 pr-3">Schedule</th><th class="py-2 pr-3">Status</th><th class="py-2 pr-3">Posted</th><th class="py-2"></th></tr></thead><tbody>'
      + rows.map(r => {
        const cancellable = r.status === 'pending';
        const fbLink = r.posted_fb_id ? '<a href="https://facebook.com/' + esc(r.posted_fb_id) + '" target="_blank" class="underline text-xs">FB ↗</a>' : '';
        return '<tr class="border-b border-border align-top">'
          + '<td class="py-2 pr-3 muted text-xs">#' + r.id + '</td>'
          + '<td class="py-2 pr-3 text-xs">' + esc(r.group_name || r.group_id) + '</td>'
          + '<td class="py-2 pr-3 text-xs max-w-xs"><div class="truncate" title="' + esc(r.content) + '">' + esc(String(r.content).slice(0, 80)) + '</div>'
          + (r.error ? '<div class="text-[11px] text-red-600 mt-1">⚠ ' + esc(r.error) + '</div>' : '')
          + '</td>'
          + '<td class="py-2 pr-3 muted text-xs">' + esc(fmtTime(r.schedule_at)) + '</td>'
          + '<td class="py-2 pr-3"><span class="text-[11px] px-2 py-0.5 rounded ' + pillClass(r.status) + '">' + esc(r.status) + '</span></td>'
          + '<td class="py-2 pr-3 muted text-xs">' + esc(fmtTime(r.posted_at)) + ' ' + fbLink + '</td>'
          + '<td class="py-2 text-right">'
          + (cancellable ? '<button data-cancel="' + r.id + '" class="btn btn-ghost text-xs">✗ Cancel</button>' : '')
          + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    list.querySelectorAll('[data-cancel]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Cancel bài này?')) return;
        const id = b.dataset.cancel;
        const r = await fetch('/api/posts/queue/' + id, { method: 'DELETE', credentials: 'same-origin' });
        if (r.ok) loadComposeQueue();
      };
    });
  } catch (e) {
    list.innerHTML = '<span class="text-xs text-red-600">Lỗi load: ' + esc(String(e?.message ?? e)) + '</span>';
  }
}

// ── REPLIES: AI-suggested reply approval queue ────────────────────────
let _repliesPoll = null;
async function loadReplies(){
  const rfb = $('btnRefreshReplies');
  if (rfb && !rfb._wired) { rfb._wired = true; rfb.onclick = renderRepliesQueue; }
  await renderRepliesQueue();
  if (_repliesPoll) clearInterval(_repliesPoll);
  _repliesPoll = setInterval(() => {
    if (!document.querySelector('[data-view="replies"]').classList.contains('hidden')) renderRepliesQueue();
  }, 30000);
}

async function renderRepliesQueue(){
  const list = $('repliesQueueList');
  if (!list) return;
  try {
    const j = await getJson('/api/replies/queue?limit=50');
    const rows = j?.rows || [];
    if (!rows.length) { list.innerHTML = '<span class="muted text-xs">Chưa có reply nào cần duyệt.</span>'; return; }
    list.innerHTML = rows.map(r => {
      const fbLink = r.post_permalink ? '<a href="' + esc(r.post_permalink) + '" target="_blank" class="underline text-xs ml-2">Xem post ↗</a>' : '';
      return '<div class="ui-card p-4 mb-3" data-reply-id="' + r.id + '">'
        + '<div class="flex items-center justify-between mb-2">'
        + '<div class="text-xs muted">#' + r.id + ' • ' + esc(r.group_name || '') + ' • <span class="text-amber-700">' + esc(r.intent || 'lead') + '</span>' + fbLink + '</div>'
        + '<div class="text-[11px] muted">' + esc(fmtTime(r.created_at)) + '</div>'
        + '</div>'
        + '<div class="bg-gray-50 dark:bg-gray-800 p-3 rounded text-xs mb-3 max-h-32 overflow-y-auto">'
        + '<div class="font-medium muted mb-1">Post của khách:</div>'
        + esc(String(r.post_message || '').slice(0, 600))
        + '</div>'
        + '<label class="block text-xs font-medium mb-1">💬 Suggested reply (chỉnh sửa nếu cần):</label>'
        + '<textarea data-final-text rows="3" class="form-input w-full text-sm" style="font-family:inherit;">' + esc(r.suggested_text) + '</textarea>'
        + '<div class="flex gap-2 mt-3">'
        + '<button data-approve="' + r.id + '" class="btn btn-primary text-sm">✓ Duyệt + gửi</button>'
        + '<button data-skip="' + r.id + '" class="btn btn-ghost text-sm">✗ Bỏ qua</button>'
        + '<span data-msg class="muted text-xs self-center"></span>'
        + '</div></div>';
    }).join('');
    list.querySelectorAll('[data-approve]').forEach(b => {
      b.onclick = async () => {
        const card = b.closest('[data-reply-id]');
        const id   = b.dataset.approve;
        const ft   = card.querySelector('[data-final-text]').value.trim();
        const msg  = card.querySelector('[data-msg]');
        if (ft.length < 3) { msg.textContent = '✗ Reply quá ngắn'; return; }
        b.disabled = true; msg.textContent = '⏳ Đang queue…';
        try {
          const r = await fetch('/api/replies/queue/' + id + '/approve', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ final_text: ft }),
          });
          if (!r.ok) throw new Error('lỗi server');
          msg.textContent = '✓ Đã queue';
          setTimeout(renderRepliesQueue, 800);
        } catch (e) { msg.textContent = '✗ ' + e.message; b.disabled = false; }
      };
    });
    list.querySelectorAll('[data-skip]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Bỏ qua reply này?')) return;
        const r = await fetch('/api/replies/queue/' + b.dataset.skip, { method: 'DELETE', credentials: 'same-origin' });
        if (r.ok) renderRepliesQueue();
      };
    });
  } catch (e) {
    list.innerHTML = '<span class="text-xs text-red-600">Lỗi load: ' + esc(String(e?.message ?? e)) + '</span>';
  }
}

// Wire pill click handlers
document.querySelectorAll('.setup-pill').forEach(p => {
  p.onclick = () => setSetupSection(p.dataset.setupSection);
});

async function loadEtl(){
  // Render the agent banner (next ETL countdown / live crawl progress) at top.
  fetch('/api/dashboard/agent/status', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(j => { const el = $('etlBanner'); if (el) el.innerHTML = buildAgentBannerHtml(j); })
    .catch(() => {});

  const e = await getJson('/api/runs?limit=50');
  if (!e) return;
  $('etlTbl').querySelector('tbody').innerHTML = (e.rows ?? []).map(r =>
    '<tr><td class="muted">' + r.id + '</td>' +
    '<td><code>' + esc(r.kind) + '</code></td>' +
    '<td>' + esc(r.scope ?? '') + '</td>' +
    '<td class="muted">' + esc(fmtTime(r.started_at)) + '</td>' +
    '<td class="muted">' + esc(fmtTime(r.finished_at)) + '</td>' +
    '<td class="s-' + esc(r.status) + '">' + esc(r.status) + '</td>' +
    '<td class="num">' + fmtN(r.rows_total) + '</td>' +
    '<td class="num">' + fmtN(r.rows_upserted) + '</td>' +
    '<td class="muted">' + esc(String(r.message ?? '').slice(0, 200)) + '</td></tr>'
  ).join('') || '<tr><td colspan="9" class="muted">no runs</td></tr>';
}

// ── Lead rule templates — preset starting points per industry.
// NOTE: outer renderApp is a TS template literal so backticks are escaped to \\n.
const LEAD_RULE_TEMPLATES = {
  pod: 'Tôi bán dịch vụ in áo POD (print on demand) / phonecase / mug. Lead bao gồm:\\n- Khách hỏi giá in áo, hỏi xưởng in áo / phonecase / mug\\n- Khách tìm nhà cung cấp POD cho dropshipping (Etsy, Amazon)\\n- Khách hỏi về chất liệu, công nghệ in (DTG/DTF/sublimation)\\n- Khách hỏi MOQ, giá sỉ, sample\\nBỏ qua:\\n- Bài tuyển dụng designer, seller, marketer\\n- Bài seeding kêu like share\\n- Bài khoe sản phẩm đã in (không có ý mua)',
  mmo: 'Tôi cung cấp tools/services cho MMO / dropshipping. Lead bao gồm:\\n- Khách hỏi tìm tool spy ads, tool research keyword\\n- Khách hỏi dịch vụ fulfill, logistics, payment\\n- Khách hỏi VPS / proxy / hosting cho MMO\\n- Khách tìm mentor, khóa học MMO/dropship\\nBỏ qua:\\n- Bài share kinh nghiệm không có nhu cầu mua\\n- Bài tuyển dụng / hợp tác PR\\n- Bài quảng cáo tools cạnh tranh',
  bds: 'Tôi là môi giới bất động sản. Lead bao gồm:\\n- Khách muốn mua / thuê căn hộ, nhà phố, đất nền cụ thể\\n- Khách có ngân sách, khu vực, loại hình rõ ràng\\n- Khách hỏi định giá BĐS, thẩm định\\n- Khách cần vay ngân hàng để mua BĐS\\nBỏ qua:\\n- Bài đăng bán BĐS (đối thủ)\\n- Bài tuyển sale BĐS\\n- Bài chia sẻ kiến thức không có nhu cầu giao dịch',
  tuyendung: 'Tôi làm headhunt / tuyển dụng. Lead bao gồm:\\n- Bài đăng tìm công việc / ứng viên đang tìm việc\\n- Bài hỏi về mức lương ngành / vị trí cụ thể\\n- Bài chia sẻ CV tìm việc\\n- Bài hỏi xin remote / part-time / hợp đồng\\nBỏ qua:\\n- Bài nhà tuyển dụng đăng tin tuyển (đối thủ)\\n- Bài đào tạo kỹ năng (trừ khi có ý tìm việc)\\n- Bài chia sẻ chung không có ý định ứng tuyển',
  dichvu: 'Tôi cung cấp dịch vụ in ấn / sản xuất (offset, decal, name card, brochure, vinyl, banner). Lead bao gồm:\\n- Khách hỏi báo giá in cụ thể (số lượng, kích thước, chất liệu)\\n- Khách tìm xưởng in cho order định kỳ\\n- Khách hỏi mẫu, thời gian giao, ship COD\\n- Khách hỏi thiết kế + in trọn gói\\nBỏ qua:\\n- Bài giới thiệu xưởng in khác (đối thủ)\\n- Bài tuyển nhân viên thiết kế\\n- Bài seeding sản phẩm in',
  spa: 'Tôi sở hữu spa / dịch vụ làm đẹp. Lead bao gồm:\\n- Khách hỏi giá liệu trình da, tóc, mi, móng\\n- Khách tìm spa gần khu vực cụ thể\\n- Khách hỏi review, kết quả của dịch vụ\\n- Khách hỏi liệu trình điều trị (mụn, nám, sẹo)\\nBỏ qua:\\n- Bài tuyển KTV, học viên\\n- Bài chia sẻ kiến thức làm đẹp không có ý đặt lịch\\n- Bài quảng cáo của spa khác',
  fnb: 'Tôi sở hữu nhà hàng / quán ăn / F&B. Lead bao gồm:\\n- Khách hỏi đặt bàn, đặt tiệc số đông\\n- Khách hỏi menu, giá, ship đồ ăn\\n- Khách hỏi cho thuê mặt bằng nấu / sự kiện\\n- Khách hỏi nguồn nguyên liệu, supplier (nếu bán B2B)\\nBỏ qua:\\n- Bài giới thiệu quán khác\\n- Bài tuyển nhân viên bếp, phục vụ\\n- Bài chia sẻ công thức nấu ăn',
};
$('leadRuleTemplate') && ($('leadRuleTemplate').onchange = () => {
  const key = $('leadRuleTemplate').value;
  if (!key || !LEAD_RULE_TEMPLATES[key]) return;
  const ta = $('setLeadRules');
  // Don't overwrite if user already typed something — only fill if empty/short.
  if (ta.value.trim().length > 30) {
    if (!confirm('Textarea đang có nội dung. Ghi đè bằng template "' + key + '"?')) {
      $('leadRuleTemplate').value = ''; // reset dropdown
      return;
    }
  }
  ta.value = LEAD_RULE_TEMPLATES[key];
  toast('Đã load template "' + key + '" — chỉnh sửa cho phù hợp shop bạn rồi Save', 'success');
});

// ── Settings (Telegram + classifier)
async function loadSettings() {
  const r = await fetch('/api/settings', { credentials: 'same-origin' });
  const j = await r.json();
  const cfg = j.config || {};
  if ($('setFbName'))   $('setFbName').value   = cfg.fb_display_name || '';
  if ($('setFbAvatar')) $('setFbAvatar').value = cfg.fb_avatar_url   || '';
  $('setTgToken').value   = cfg.telegram_bot_token || '';
  $('setTgChat').value    = cfg.telegram_chat_id || '';
  renderTgChatBox(cfg.telegram_chat_id, cfg.telegram_chat_title);
  // Pre-select saved topic IDs (options populated by Detect button).
  window._savedTopicHr      = cfg.telegram_topic_hr ?? '';
  window._savedTopicFulfill = cfg.telegram_topic_fulfill ?? '';
  if ($('setTgTopicHr')      && cfg.telegram_topic_hr)      ensureTopicOption('setTgTopicHr',      cfg.telegram_topic_hr,      'Lead HR (saved)');
  if ($('setTgTopicFulfill') && cfg.telegram_topic_fulfill) ensureTopicOption('setTgTopicFulfill', cfg.telegram_topic_fulfill, 'Lead fulfill (saved)');
  $('setClsEnabled').checked = cfg.classifier_enabled !== false;
  if ($('setGeminiKey')) $('setGeminiKey').value = cfg.gemini_api_key || '';
  $('setLeadRules').value = cfg.lead_rules || '';
  const conf = Math.round((cfg.lead_min_confidence ?? 0) * 100);
  $('setMinConf').value = String(conf);
  $('setMinConfV').textContent = conf + '%';
  $('setMinConf').oninput = () => { $('setMinConfV').textContent = $('setMinConf').value + '%'; };
  $('setMaxAge').value = String(cfg.lead_max_age_days ?? 7);
  if ($('setDedupDays')) $('setDedupDays').value = String(cfg.lead_dedup_days ?? 7);
  // Auto-reply settings
  if ($('setAutoReplyEnabled'))     $('setAutoReplyEnabled').checked = cfg.auto_reply_enabled === true;
  if ($('setAutoReplyIntents'))     $('setAutoReplyIntents').value   = (cfg.auto_reply_intents || []).join(', ');
  if ($('setAutoReplyShopContext')) $('setAutoReplyShopContext').value = cfg.auto_reply_shop_context || '';
  if ($('setMaxPostsPerDay'))       $('setMaxPostsPerDay').value     = String(cfg.max_posts_per_day ?? 20);
  if ($('setMaxRepliesPerDay'))     $('setMaxRepliesPerDay').value   = String(cfg.max_replies_per_day ?? 50);
  // Fire the Gemini-usage panel load whenever Settings opens (cheap query, ~50ms).
  loadGeminiUsage();
  loadBlocklist();
}

async function loadBlocklist(){
  const el = $('blocklistTable');
  if (!el) return;
  try {
    const j = await getJson('/api/blocklist');
    const rows = j?.rows || [];
    if (!rows.length) {
      el.innerHTML = '<p class="muted text-xs">Chưa block công ty / tác giả nào.</p>';
      return;
    }
    el.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-muted-foreground border-b border-border">'
      + '<th class="py-2 pr-3">Scope</th><th class="py-2 pr-3">Tên</th><th class="py-2 pr-3">Khi block</th><th class="py-2 pr-3">Bởi</th><th class="py-2"></th></tr></thead><tbody>'
      + rows.map(r => '<tr class="border-b border-border/50">'
        + '<td class="py-1.5 pr-3"><span class="text-[10px] px-1.5 py-0.5 rounded ' + (r.scope==='org' ? 'bg-amber-100 text-amber-900' : 'bg-blue-100 text-blue-900') + '">' + esc(r.scope) + '</span></td>'
        + '<td class="py-1.5 pr-3"><div class="font-medium">' + esc(r.display_name || r.pattern) + '</div>'
        + (r.display_name && r.display_name !== r.pattern ? '<div class="text-[10px] muted">match: ' + esc(r.pattern) + '</div>' : '') + '</td>'
        + '<td class="py-1.5 pr-3 muted text-xs">' + esc(fmtTime(r.created_at)) + '<br><span class="text-[10px]">via ' + esc(r.created_via || '?') + '</span></td>'
        + '<td class="py-1.5 pr-3 muted text-xs">' + esc(r.created_by || '?') + '</td>'
        + '<td class="py-1.5 text-right"><button data-unblock="' + r.id + '" class="btn btn-ghost text-xs">✗ Remove</button></td>'
        + '</tr>').join('') + '</tbody></table></div>';
    el.querySelectorAll('[data-unblock]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Remove block? Lead mới của công ty này sẽ lại pop alert.')) return;
        const r = await fetch('/api/blocklist/' + b.dataset.unblock, { method:'DELETE', credentials:'same-origin' });
        if (r.ok) loadBlocklist();
      };
    });
  } catch (e) {
    el.innerHTML = '<span class="text-xs text-red-600">Lỗi load: ' + esc(String(e?.message ?? e)) + '</span>';
  }
}
$('btnReloadBlocklist') && ($('btnReloadBlocklist').onclick = loadBlocklist);
$('btnAddBlock') && ($('btnAddBlock').onclick = async () => {
  const scope = $('blkScope').value;
  const pattern = $('blkPattern').value.trim();
  if (!pattern) { toast('Cần điền tên/ID','warn'); return; }
  const r = await fetch('/api/blocklist', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'},
    body: JSON.stringify({ scope, pattern, display_name: pattern }) });
  const j = await r.json();
  if (j.ok) { $('blkPattern').value = ''; toast('Đã thêm','success'); loadBlocklist(); }
  else      { toast('Lỗi: ' + (j.error||'?'),'error'); }
});

// ─── Gemini usage / cost panel (Setup → Cấu hình) ────────────────────────
const fmtInt = n => Number(n||0).toLocaleString('vi-VN');
const fmtVnd = n => Number(n||0).toLocaleString('vi-VN') + ' ₫';
const fmtUsd = n => '$' + (Number(n||0)).toFixed(4);
async function loadGeminiUsage(){
  const sel = $('geminiUsageDays');
  const days = sel ? sel.value : '14';
  const body = $('geminiUsageBody');
  const purBody = $('geminiPurposeBody');
  const totals = $('geminiUsageTotals');
  if (!body) return; // Setup tab not rendered yet
  body.innerHTML = '<tr><td colspan="7" class="py-3 text-muted-foreground">Loading…</td></tr>';
  let j;
  try {
    const r = await fetch('/api/dashboard/gemini-usage?days=' + days, { credentials:'same-origin' });
    j = await r.json();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="7" class="py-3 text-red-500">Lỗi: ' + (e.message||e) + '</td></tr>';
    return;
  }
  const t = j.totals || {};
  totals.innerHTML = [
    ['Tổng calls',   fmtInt(t.calls),         t.errors ? (fmtInt(t.errors)+' lỗi') : 'ok'],
    ['Input tokens', fmtInt(t.prompt_tokens), j.model || ''],
    ['Output tokens',fmtInt(t.output_tokens), ''],
    ['Chi phí',      fmtVnd(t.cost_vnd),      fmtUsd(t.cost_usd)],
  ].map(([k,v,sub]) => '<div class="bg-card border border-border rounded p-2"><div class="text-[10px] text-muted-foreground uppercase">'+k+'</div><div class="text-base font-semibold">'+v+'</div><div class="text-[10px] text-muted-foreground">'+sub+'</div></div>').join('');
  if (!j.daily || !j.daily.length) {
    body.innerHTML = '<tr><td colspan="7" class="py-3 text-muted-foreground">Chưa có call Gemini nào trong '+days+' ngày qua.</td></tr>';
  } else {
    body.innerHTML = j.daily.map(r =>
      '<tr class="border-b border-border/50 hover:bg-accent/30">'
      +'<td class="py-1.5 pr-3 font-mono">'+r.day+'</td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.calls)+(r.errors?' <span class="text-red-500">('+r.errors+')</span>':'')+'</td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.prompt_tokens)+'</td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.output_tokens)+'</td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.total_tokens)+'</td>'
      +'<td class="py-1.5 pr-3 text-right font-mono">'+fmtUsd(r.cost_usd)+'</td>'
      +'<td class="py-1.5 pr-3 text-right font-mono">'+fmtVnd(r.cost_vnd)+'</td>'
      +'</tr>'
    ).join('');
  }
  if (purBody) {
    purBody.innerHTML = (j.by_purpose || []).map(r =>
      '<tr class="border-b border-border/50">'
      +'<td class="py-1.5 pr-3"><code class="text-[11px]">'+r.purpose+'</code></td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.calls)+'</td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.prompt_tokens)+'</td>'
      +'<td class="py-1.5 pr-3 text-right">'+fmtInt(r.output_tokens)+'</td>'
      +'<td class="py-1.5 pr-3 text-right font-mono">'+fmtVnd(r.cost_vnd)+'</td>'
      +'</tr>'
    ).join('') || '<tr><td colspan="5" class="py-2 text-muted-foreground">—</td></tr>';
  }
}
$('btnReloadGeminiUsage') && ($('btnReloadGeminiUsage').onclick = loadGeminiUsage);
$('geminiUsageDays')      && ($('geminiUsageDays').onchange   = loadGeminiUsage);

$('btnReclassifyAll') && ($('btnReclassifyAll').onclick = async () => {
  if (!confirm('⚠ Sẽ XOÁ toàn bộ lead hiện tại + re-classify mọi post với rule mới.\\n\\nTốn Gemini quota tỉ lệ với số post. Kanban + Reports sẽ trống vài phút.\\n\\nXác nhận?')) return;
  $('btnReclassifyAll').disabled = true;
  $('btnReclassifyAll').textContent = '⏳ Đang xử lý...';
  try {
    const r = await fetch('/api/leads/reclassify-all', { method:'POST', credentials:'same-origin' });
    const j = await r.json();
    if (j.ok) {
      $('settingsMsg2').textContent = '✓ ' + j.message;
      toast('Re-classify started — refresh Leads sau vài phút','success', 8000);
    } else {
      $('settingsMsg2').textContent = '✗ ' + (j.message || j.error || 'Lỗi');
      toast('Lỗi','error');
    }
  } catch (e) { toast('Lỗi mạng: ' + e.message,'error'); }
  finally {
    $('btnReclassifyAll').disabled = false;
    $('btnReclassifyAll').textContent = '🔄 Re-classify all posts';
  }
});
$('btnSettingsSave2') && ($('btnSettingsSave2').onclick = async () => {
  $('btnSettingsSave2').disabled = true;
  const intentsRaw = $('setAutoReplyIntents') ? $('setAutoReplyIntents').value.trim() : '';
  const body = {
    lead_rules:          $('setLeadRules').value.trim() || null,
    lead_min_confidence: parseInt($('setMinConf').value, 10) / 100,
    lead_max_age_days:   Math.max(0, parseInt($('setMaxAge').value, 10) || 0),
    lead_dedup_days:     $('setDedupDays') ? Math.max(0, parseInt($('setDedupDays').value, 10) || 0) : 7,
    classifier_enabled:  $('setClsEnabled').checked,
    gemini_api_key:      $('setGeminiKey') ? ($('setGeminiKey').value.trim() || null) : undefined,
    auto_reply_enabled:  $('setAutoReplyEnabled') ? $('setAutoReplyEnabled').checked : undefined,
    auto_reply_intents:  intentsRaw ? intentsRaw.split(/[,\\n]+/).map(s => s.trim()).filter(Boolean) : [],
    auto_reply_shop_context: $('setAutoReplyShopContext') ? ($('setAutoReplyShopContext').value.trim() || null) : undefined,
    max_posts_per_day:   $('setMaxPostsPerDay')   ? Math.max(0, parseInt($('setMaxPostsPerDay').value, 10) || 20) : undefined,
    max_replies_per_day: $('setMaxRepliesPerDay') ? Math.max(0, parseInt($('setMaxRepliesPerDay').value, 10) || 50) : undefined,
  };
  const r = await fetch('/api/settings', { method:'PATCH', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json();
  $('btnSettingsSave2').disabled = false;
  if (j.ok) { $('settingsMsg2').textContent = '✓ Saved — post mới crawl về sẽ dùng rules này'; toast('Saved','success'); }
  else      { $('settingsMsg2').textContent = '✗ Lỗi: ' + (j.message||j.error); toast('Lỗi','error'); }
});
$('btnSettingsSave').onclick = async () => {
  $('btnSettingsSave').disabled = true;
  const body = {
    fb_display_name:        $('setFbName')?.value.trim()   || null,
    fb_avatar_url:          $('setFbAvatar')?.value.trim() || null,
    telegram_bot_token:     $('setTgToken').value.trim() || null,
    telegram_chat_id:       $('setTgChat').value.trim() || null,
    telegram_topic_hr:      $('setTgTopicHr')?.value      ? Number($('setTgTopicHr').value)      : null,
    telegram_topic_fulfill: $('setTgTopicFulfill')?.value ? Number($('setTgTopicFulfill').value) : null,
    classifier_enabled:     $('setClsEnabled').checked,
  };
  const r = await fetch('/api/settings', { method: 'PATCH', credentials: 'same-origin', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json();
  $('btnSettingsSave').disabled = false;
  if (j.ok) { $('settingsMsg').textContent = '✓ Saved'; toast('Settings đã lưu','success'); }
  else      { $('settingsMsg').textContent = '✗ Lỗi: ' + (j.message||j.error); toast('Lỗi','error'); }
};
$('btnSettingsTest').onclick = async () => {
  $('btnSettingsTest').disabled = true;
  $('settingsMsg').textContent = '⏳ Đang gửi test message…';
  const r = await fetch('/api/settings/telegram/test', { method:'POST', credentials:'same-origin' });
  const j = await r.json();
  $('btnSettingsTest').disabled = false;
  if (j.ok) { $('settingsMsg').textContent = '✅ Gửi thành công — check Telegram của bạn'; toast('Test OK','success'); }
  else      { $('settingsMsg').textContent = '❌ ' + (j.error || 'Lỗi không xác định'); toast('Test fail','error'); }
};

function renderTgChatBox(chatId, title){
  const box = $('setTgChatBox');
  if (!box) return;
  if (!chatId) {
    box.innerHTML = 'Chưa detect — paste token rồi bấm <b>🔍 Detect chat</b>';
    box.style.color = 'var(--text-muted)';
    return;
  }
  const label = title ? esc(title) : 'Chat đã lưu';
  box.innerHTML = '✅ <b>' + label + '</b> · <code style="font-size:12px;">id ' + esc(String(chatId)) + '</code>';
  box.style.color = '#9eecbe';
}
function renderTgChatPicker(chats){
  const box = $('setTgChatBox');
  if (chats.length === 1) {
    const c = chats[0];
    $('setTgChat').value = String(c.id);
    renderTgChatBox(c.id, c.title + ' (' + c.type + ')');
    // Persist immediately so reload doesn't lose it.
    fetch('/api/settings', { method:'PATCH', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify({ telegram_chat_id: String(c.id), telegram_chat_title: c.title + ' (' + c.type + ')' }) });
    toast('Đã detect: ' + c.title, 'success');
    return;
  }
  box.style.color = 'var(--text)';
  box.innerHTML = '<div style="margin-bottom:8px;">Tìm thấy ' + chats.length + ' chats — chọn 1:</div>' +
    chats.map(c =>
      '<button type="button" class="js-tg-pick" data-id="' + esc(String(c.id)) + '" data-title="' + esc(c.title + ' (' + c.type + ')') + '" style="display:block; width:100%; text-align:left; padding:8px 12px; margin-bottom:4px; background:var(--bg-card); border:1px solid var(--border-strong); border-radius:4px; color:var(--text); cursor:pointer;">' +
      '<b>' + esc(c.title) + '</b> <span style="color:var(--text-muted); font-size:12px;">· ' + esc(c.type) + ' · id ' + esc(String(c.id)) + '</span></button>'
    ).join('');
  box.querySelectorAll('.js-tg-pick').forEach(btn => {
    btn.onclick = () => {
      $('setTgChat').value = btn.dataset.id;
      renderTgChatBox(btn.dataset.id, btn.dataset.title);
      fetch('/api/settings', { method:'PATCH', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify({ telegram_chat_id: btn.dataset.id, telegram_chat_title: btn.dataset.title }) });
      toast('Đã chọn: ' + btn.dataset.title, 'success');
    };
  });
}
$('btnTgDetect') && ($('btnTgDetect').onclick = async () => {
  const token = $('setTgToken').value.trim();
  if (!token) { toast('Paste bot token trước', 'error'); return; }
  $('btnTgDetect').disabled = true;
  $('btnTgDetect').textContent = '⏳ Đang dò…';
  // Save the token first so test/save can use it even if user navigates away.
  await fetch('/api/settings', { method:'PATCH', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify({ telegram_bot_token: token }) });
  try {
    const r = await fetch('/api/settings/telegram/detect-chat', {
      method: 'POST', credentials: 'same-origin',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ bot_token: token }),
    });
    const j = await r.json();
    if (!j.ok) {
      $('setTgChatBox').innerHTML = '❌ ' + esc(j.error || 'Lỗi');
      $('setTgChatBox').style.color = '#ff8a8a';
      toast(j.error || 'Detect fail', 'error');
    } else if (!j.chats || j.chats.length === 0) {
      $('setTgChatBox').innerHTML = '⚠️ ' + esc(j.message || 'Chưa có chat nào');
      $('setTgChatBox').style.color = '#ffce72';
    } else {
      renderTgChatPicker(j.chats);
    }
  } catch (e) { toast('Lỗi mạng: ' + e.message, 'error'); }
  finally {
    $('btnTgDetect').disabled = false;
    $('btnTgDetect').textContent = '🔍 Detect chat';
  }
});

function ensureTopicOption(selectId, threadId, label){
  const sel = $(selectId);
  if (!sel) return;
  if (Array.from(sel.options).some(o => o.value === String(threadId))) { sel.value = String(threadId); return; }
  const o = document.createElement('option');
  o.value = String(threadId);
  o.textContent = label + '  · id ' + threadId;
  sel.appendChild(o);
  sel.value = String(threadId);
}
function populateTopicSelects(topics){
  for (const id of ['setTgTopicHr','setTgTopicFulfill']) {
    const sel = $(id);
    if (!sel) continue;
    // Keep the placeholder + any saved option, drop the rest, then re-add.
    const saved = sel.value;
    sel.innerHTML = (id === 'setTgTopicHr'
      ? '<option value="">— Lead HR — General —</option>'
      : '<option value="">— Lead fulfill — General —</option>');
    for (const t of topics) {
      const o = document.createElement('option');
      o.value = String(t.thread_id);
      o.textContent = t.name + '  · id ' + t.thread_id;
      sel.appendChild(o);
    }
    if (saved) sel.value = saved;
  }
}
$('btnTgDetectTopics') && ($('btnTgDetectTopics').onclick = async () => {
  $('btnTgDetectTopics').disabled = true;
  $('btnTgDetectTopics').textContent = '⏳';
  try {
    const r = await fetch('/api/settings/telegram/detect-topics', { method: 'POST', credentials: 'same-origin', headers: {'content-type':'application/json'}, body: '{}' });
    const j = await r.json();
    if (!j.ok)               { toast(j.error || 'Lỗi', 'error'); }
    else if (!j.topics?.length) { toast(j.message || 'Chưa thấy topic nào', 'error', 6000); }
    else                       { populateTopicSelects(j.topics); toast('Đã detect ' + j.topics.length + ' topics', 'success'); }
  } catch (e) { toast('Lỗi mạng: ' + e.message, 'error'); }
  finally {
    $('btnTgDetectTopics').disabled = false;
    $('btnTgDetectTopics').textContent = '🔍 Detect topics';
  }
});

// FB account auto-fetch (parallel-safe, no chrome-profile contention)
$('btnFbAutoFetch') && ($('btnFbAutoFetch').onclick = async () => {
  const btn = $('btnFbAutoFetch');
  btn.disabled = true; btn.textContent = '⏳ Queued (~60s heartbeat tick)';
  try {
    const r = await fetch('/api/dashboard/agent/command', {
      method: 'POST', credentials: 'same-origin',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ cmd: 'refresh_owner_profile' }),
    });
    const j = await r.json();
    if (j.ok) {
      toast('Đã queue. Đợi ~60-90s rồi reload Settings để thấy tên/avatar mới.', 'success', 8000);
      // Auto-reload settings after 90s to pull in new values
      setTimeout(() => loadSettings(), 90_000);
    } else {
      toast('Lỗi: ' + (j.message || j.error || '?'), 'error');
    }
  } catch (e) { toast('Lỗi mạng: ' + e.message, 'error'); }
  finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 Auto-fetch từ VPS'; }, 5000);
  }
});

// ── Insights
async function loadInsights(){
  const list = $('insightsList');
  list.innerHTML = '<span class="muted">Đang tải…</span>';
  const j = await getJson('/api/insights');
  const rows = j?.rows ?? [];
  if (rows.length === 0) {
    list.innerHTML = '<div class="panel" style="padding:20px; text-align:center;"><p class="muted">Chưa có insights nào.</p><p class="muted" style="font-size:12px;">Bấm <strong>⚡ Generate now</strong> ở trên để chạy phân tích cho tuần hiện tại.</p></div>';
    return;
  }
  // Group by week_start
  const byWeek = {};
  for (const r of rows) {
    (byWeek[r.week_start] = byWeek[r.week_start] || []).push(r);
  }
  const weeks = Object.keys(byWeek).sort().reverse();
  const catMeta = {
    hr:      { label: '💼 HR (Tuyển dụng)',  color: '#a78bfa' },
    fulfill: { label: '📦 Fulfill (sup/xưởng)', color: '#22c55e' },
    other:   { label: '📌 Khác',             color: '#6b7280' },
  };
  list.innerHTML = weeks.map(week => {
    const buckets = byWeek[week];
    const headerDate = fmtTime(week + 'T00:00:00').slice(0, 10);
    return '<div class="panel" style="margin-bottom:14px; padding:16px;">' +
      '<h3 style="margin:0 0 12px; font-size:15px;">Tuần bắt đầu ' + esc(headerDate) + '</h3>' +
      '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:14px;">' +
        buckets.filter(b => b.category !== 'other').map(b => renderInsightCard(b, catMeta[b.category])).join('') +
      '</div>' +
    '</div>';
  }).join('');
}
function renderInsightCard(b, meta){
  let g = null;
  try { g = JSON.parse(b.gemini_summary || '{}'); } catch (e) { g = { error: 'parse_failed', raw: b.gemini_summary }; }

  if (g.error) {
    return '<div style="background:var(--bg-card); border-left:3px solid ' + meta.color + '; border-radius:6px; padding:12px;">' +
      '<strong style="color:' + meta.color + ';">' + meta.label + '</strong>' +
      '<div class="muted" style="font-size:11px; margin-top:6px;">⚠ Gemini error: ' + esc(g.error) + (g.finish_reason ? ' (' + esc(g.finish_reason) + ')' : '') + '</div>' +
    '</div>';
  }
  const stats = g.stats || {};
  const competitors = g.competitors || [];
  const prices = g.prices || [];
  const products = g.hot_products || [];
  const actions  = g.actions || [];
  const prColor = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };

  return '<div style="background:var(--bg-card); border-left:4px solid ' + meta.color + '; border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:14px;">' +
    // Header + headline
    '<div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">' +
        '<strong style="color:' + meta.color + '; font-size:14px;">' + meta.label + '</strong>' +
        '<span class="muted" style="font-size:11px;">' + (stats.total_comments ?? b.total_comments) + ' comments</span>' +
      '</div>' +
      (g.headline ? '<div style="font-size:13px; line-height:1.45; padding:8px 10px; background:var(--bg-hover); border-radius:5px; color:var(--text);">💡 ' + esc(g.headline) + '</div>' : '') +
    '</div>' +

    // Stat cards (4 numbers)
    '<div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:6px;">' +
      mkStat(stats.total_comments,    'comments') +
      mkStat(stats.contact_rate_pct + '%', 'có contact') +
      mkStat(stats.price_rate_pct + '%',   'có giá') +
      mkStat(stats.unique_competitors,'đối thủ') +
    '</div>' +

    // Competitors table
    (competitors.length === 0 ? '' :
      '<div>' +
        '<div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase;">🎯 Top đối thủ (' + competitors.length + ')</div>' +
        '<div style="background:var(--bg-input); border-radius:5px; padding:8px;">' +
          competitors.slice(0, 5).map(c =>
            '<div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:12px;">' +
              '<div>' + (c.profile ? '<a href="' + esc(c.profile) + '" target="_blank" style="color:hsl(var(--primary)); font-weight:600;">' + esc(c.name) + ' ↗</a>' : '<strong>' + esc(c.name) + '</strong>') + '</div>' +
              '<div class="muted" style="font-size:11px; margin-top:2px;">' + esc(c.offers || '') + '</div>' +
              (c.evidence ? '<div style="font-size:11px; font-style:italic; color:var(--text-muted); margin-top:2px;">"' + esc(c.evidence) + '"</div>' : '') +
            '</div>'
          ).join('') +
        '</div>' +
      '</div>') +

    // Prices
    (prices.length === 0 ? '' :
      '<div>' +
        '<div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase;">💰 Giá thị trường</div>' +
        '<div style="display:flex; flex-direction:column; gap:4px;">' +
          prices.slice(0, 5).map(p =>
            '<div style="display:flex; justify-content:space-between; gap:8px; background:var(--bg-input); padding:6px 10px; border-radius:4px; font-size:12px;">' +
              '<span style="flex:1;">' + esc(p.item) + (p.from ? ' <span class="muted">· ' + esc(p.from) + '</span>' : '') + '</span>' +
              '<strong style="color:#9eecbe; white-space:nowrap;">' + esc(p.price) + '</strong>' +
            '</div>'
          ).join('') +
        '</div>' +
      '</div>') +

    // Hot products as tags
    (products.length === 0 ? '' :
      '<div>' +
        '<div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase;">🔥 Sản phẩm hot</div>' +
        '<div style="display:flex; flex-wrap:wrap; gap:5px;">' +
          products.map(p =>
            '<span style="padding:3px 8px; background:#1f3f2a; color:#9eecbe; border-radius:99px; font-size:11px;">' + esc(p.name) + (p.n_signal ? ' · ' + p.n_signal : '') + '</span>'
          ).join('') +
        '</div>' +
      '</div>') +

    // Actions (3 boxes)
    (actions.length === 0 ? '' :
      '<div>' +
        '<div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase;">⚡ Hành động đề xuất</div>' +
        '<div style="display:flex; flex-direction:column; gap:6px;">' +
          actions.slice(0, 3).map(a => {
            const pc = prColor[a.priority] || '#6b7280';
            return '<div style="padding:8px 10px; background:var(--bg-input); border-left:3px solid ' + pc + '; border-radius:4px;">' +
              '<div style="font-size:12px; font-weight:600;">' + esc(a.title) + '</div>' +
              (a.why ? '<div class="muted" style="font-size:11px; margin-top:3px;">' + esc(a.why) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>') +
  '</div>';
}

function mkStat(v, label){
  return '<div style="background:var(--bg-hover); padding:8px 6px; border-radius:5px; text-align:center;">' +
    '<div style="font-size:18px; font-weight:700; color:var(--text);">' + (v ?? '–') + '</div>' +
    '<div class="muted" style="font-size:10px;">' + label + '</div>' +
  '</div>';
}
// ── Dashboard: status banner (agent state + next cron tick)
async function loadDashStatus(){
  if (!$('dashStatusBanner')) return;
  try {
    const r = await fetch('/api/dashboard/agent/status', { credentials: 'same-origin' });
    if (!r.ok) return;
    const j = await r.json();
    const dot = $('dashStatusDot'), txt = $('dashStatusText'), nxt = $('dashNextCron');
    if (!j.installed) { dot.className = 'w-2 h-2 rounded-full bg-destructive'; txt.textContent = 'Chưa cài agent trên VPS'; nxt.textContent = ''; return; }
    if (j.run_in_flight) {
      dot.className = 'w-2 h-2 rounded-full bg-warning animate-pulse';
      const prog = (j.run_groups_total && j.run_groups_total > 0) ? ' · ' + j.run_groups_done + '/' + j.run_groups_total + ' groups' : '';
      txt.textContent = '🔄 Đang crawl (' + (j.run_mode || '?') + ')' + prog;
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-success';
      txt.textContent = '✅ Agent idle · v' + (j.agent_version || '?');
    }
    // Next cron */30
    const now = new Date(); const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(now.getMinutes() < 30 ? 30 : 60);
    const diff = Math.max(1, Math.round((next.getTime() - now.getTime()) / 60000));
    nxt.textContent = 'Crawl tự động: ' + next.toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'}) + ' (trong ' + diff + ' phút)';
  } catch {}
}

// ── Dashboard: condensed Insights cards (current week only)
async function loadDashInsights(){
  if (!$('dashInsightsList')) return;
  const wrap = $('dashInsightsList');
  wrap.innerHTML = '<div class="text-xs text-muted-foreground col-span-2">Đang tải…</div>';
  const j = await getJson('/api/insights');
  const rows = (j?.rows ?? []).filter(r => r.category !== 'other');
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="col-span-2 text-center py-6"><p class="text-sm text-muted-foreground m-0">Chưa có insights nào.</p><p class="text-xs text-muted-foreground mt-1 m-0">Bấm <strong>⚡ Generate</strong> để chạy phân tích cho tuần hiện tại (~15s).</p></div>';
    $('dashInsightWeek').textContent = '';
    return;
  }
  // Group by week, take latest week
  const byWeek = {};
  for (const r of rows) (byWeek[r.week_start] = byWeek[r.week_start] || []).push(r);
  const latestWeek = Object.keys(byWeek).sort().reverse()[0];
  $('dashInsightWeek').textContent = '· tuần bắt đầu ' + fmtTime(latestWeek + 'T00:00:00').slice(0, 10);
  const buckets = byWeek[latestWeek];
  const catMeta = {
    hr:      { label: '💼 HR (Tuyển dụng)',      color: 'text-purple-500',  bg: 'bg-purple-500/10', border: 'border-l-purple-500' },
    fulfill: { label: '📦 Fulfill (sup/xưởng)',  color: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-l-emerald-500' },
  };
  wrap.innerHTML = buckets.map(b => {
    let g = null; try { g = JSON.parse(b.gemini_summary || '{}'); } catch {}
    const m = catMeta[b.category] || catMeta.fulfill;
    const stats = g?.stats || {};
    return '<div class="ui-card border-l-4 ' + m.border + ' p-4">' +
      '<div class="flex items-center justify-between mb-2">' +
        '<strong class="text-sm font-semibold ' + m.color + '">' + m.label + '</strong>' +
        '<span class="text-[11px] text-muted-foreground">' + (stats.total_comments ?? b.total_comments) + ' cmts · ' + (stats.unique_competitors || 0) + ' đối thủ</span>' +
      '</div>' +
      (g?.headline
        ? '<div class="text-[13px] leading-snug mb-3">💡 ' + esc(g.headline) + '</div>'
        : '<div class="text-xs text-muted-foreground mb-3">(no headline)</div>') +
      '<button onclick="expandDashInsights()" class="text-xs text-primary hover:underline">Xem chi tiết →</button>' +
    '</div>';
  }).join('');
  $('btnDashInsightExpand').classList.remove('hidden');
}

window.expandDashInsights = function(){
  const full = $('dashInsightsFull');
  full.classList.toggle('hidden');
  if (full.classList.contains('hidden')) { $('btnDashInsightExpand').textContent = '⤡ Mở rộng'; return; }
  $('btnDashInsightExpand').textContent = '⤢ Thu gọn';
  // Render full insight cards in expanded section
  getJson('/api/insights').then(j => {
    const rows = (j?.rows ?? []).filter(r => r.category !== 'other');
    const byWeek = {};
    for (const r of rows) (byWeek[r.week_start] = byWeek[r.week_start] || []).push(r);
    const weeks = Object.keys(byWeek).sort().reverse().slice(0, 4);
    const catMeta = {
      hr:      { label: '💼 HR (Tuyển dụng)',     color: '#a78bfa' },
      fulfill: { label: '📦 Fulfill (sup/xưởng)', color: '#22c55e' },
    };
    full.innerHTML = weeks.map(week => {
      const headerDate = fmtTime(week + 'T00:00:00').slice(0, 10);
      return '<div class="mb-4"><h4 class="text-sm font-semibold m-0 mb-2">Tuần ' + esc(headerDate) + '</h4>' +
        '<div class="grid grid-cols-1 lg:grid-cols-2 gap-3">' +
          byWeek[week].map(b => renderInsightCard(b, catMeta[b.category] || catMeta.fulfill)).join('') +
        '</div></div>';
    }).join('');
  });
};

$('btnDashInsightGen') && ($('btnDashInsightGen').onclick = async () => {
  const btn = $('btnDashInsightGen');
  btn.disabled = true; btn.textContent = '⏳ ~15s…';
  try {
    const r = await fetch('/api/insights/generate', { method: 'POST', credentials: 'same-origin' });
    const j = await r.json();
    if (j.ok) { toast('Generated', 'success'); loadDashInsights(); }
    else      toast('Lỗi: ' + (j.error || '?'), 'error');
  } catch (e) { toast('Lỗi mạng: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '⚡ Generate'; }
});

// ── Reports (Chart.js: funnel + daily + velocity + heatmap)
let _charts = {};
async function loadReports() {
  try {
    const [funnel, daily, vel, heat, kpi] = await Promise.all([
      fetch('/api/leads/funnel', {credentials:'same-origin'}).then(r=>r.json()),
      fetch('/api/leads/daily-stats', {credentials:'same-origin'}).then(r=>r.json()),
      fetch('/api/leads/velocity', {credentials:'same-origin'}).then(r=>r.json()),
      fetch('/api/leads/heatmap', {credentials:'same-origin'}).then(r=>r.json()),
      fetch('/api/leads/stats', {credentials:'same-origin'}).then(r=>r.json()),
    ]);

    // KPI cards
    const total = Object.values(kpi.stages||{}).reduce((a,b)=>a+b,0);
    const won = (kpi.stages||{}).closed_won || 0;
    $('kpiLeadsMonth').textContent = total;
    $('kpiConvRate').textContent = total ? (Math.round(won/total*100) + '%') : '0%';
    const avg = (vel.stages || []).find(s=>s.stage==='closed_won')?.avg_days;
    $('kpiAvgClose').textContent = avg ? avg.toFixed(1) + 'd' : '—';

    // Daily line chart
    renderChart('chartDaily', 'line', {
      labels: (daily.days||[]).map(d=>d.date),
      datasets: [{ label:'Leads', data: (daily.days||[]).map(d=>d.leads), borderColor:'#3b6ef0', backgroundColor:'#3b6ef022', tension:0.3 }],
    });

    // Funnel (vertical bar, descending)
    renderChart('chartFunnel', 'bar', {
      labels: (funnel.stages||[]).map(s=>s.label),
      datasets: [{ label:'Leads', data: (funnel.stages||[]).map(s=>s.count), backgroundColor: '#3b6ef0' }],
    });

    // Velocity (horizontal bar)
    renderChart('chartVelocity', 'bar', {
      labels: (vel.stages||[]).map(s=>s.label),
      datasets: [{ label:'Avg days', data: (vel.stages||[]).map(s=>s.avg_days), backgroundColor: '#fbbf24' }],
    }, { indexAxis: 'y' });

    // Heatmap (manual SVG grid)
    renderHeatmap('heatmapBox', heat.cells || []);
  } catch (e) {
    toast('Lỗi load reports: ' + e.message, 'error');
  }
}

function renderChart(canvasId, type, data, optsExtra) {
  if (_charts[canvasId]) _charts[canvasId].destroy();
  const opts = Object.assign({
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: 'var(--text-muted)', font: {size: 10} }, grid: { color: 'var(--border)' } },
      y: { ticks: { color: 'var(--text-muted)', font: {size: 10} }, grid: { color: 'var(--border)' } },
    },
  }, optsExtra || {});
  _charts[canvasId] = new Chart($(canvasId), { type, data, options: opts });
}

function renderHeatmap(boxId, cells) {
  // cells: [{dow:0-6, hour:0-23, count}]
  const grid = Array.from({length:7}, ()=>Array(24).fill(0));
  cells.forEach(c => { grid[c.dow][c.hour] = c.count; });
  const max = Math.max(1, ...cells.map(c=>c.count));
  const dowNames = ['CN','T2','T3','T4','T5','T6','T7'];
  let html = '<div style="display:grid; grid-template-columns: 30px repeat(24, 1fr); gap:2px; font-size:9px; min-width:600px;">';
  html += '<div></div>';
  for (let h=0; h<24; h++) html += '<div style="color:var(--text-muted); text-align:center;">' + h + '</div>';
  for (let d=0; d<7; d++) {
    html += '<div style="color:var(--text-muted); font-weight:600;">' + dowNames[d] + '</div>';
    for (let h=0; h<24; h++) {
      const v = grid[d][h];
      const alpha = v / max;
      html += '<div title="' + dowNames[d] + ' ' + h + 'h: ' + v + ' leads" style="background:rgba(59,110,240,' + (0.1 + alpha*0.9) + '); aspect-ratio:1; border-radius:2px;"></div>';
    }
  }
  html += '</div>';
  $(boxId).innerHTML = html;
}

// Parse "#view?key=val&..." → { view, params }. Telegram deep-links use this
// form (e.g. "#kanban?lead=585") so the hash isn't a plain view name.
function parseHash(){
  const raw = (location.hash || '#dashboard').slice(1);
  const qi  = raw.indexOf('?');
  const view = qi === -1 ? raw : raw.slice(0, qi);
  const params = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  return { view, params };
}

// ── Theme toggle (light default; persisted in localStorage)
// Uses Tailwind dark class on the html element so dark: utilities respond.
function applyTheme(theme){
  document.documentElement.classList.toggle('dark', theme === 'dark');
  const btn = $('btnTheme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem('theme', theme); } catch {}
}
(function initTheme(){
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch {}
  applyTheme(saved === 'dark' ? 'dark' : 'light');
})();
$('btnTheme') && ($('btnTheme').onclick = () => {
  const cur = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ── Refresh all
$('btnRefresh').onclick = () => {
  const { view } = parseHash();
  switchView(view);
  toast('Refreshed');
};

// ── init: figure out if user is admin (show Discover tab only for admins)
fetch('/auth/me', { credentials: 'same-origin' })
  .then(r => r.json())
  .then(j => {
    if (j.user && j.user.email) {
      // Naive: hardcoded admin emails. Could expose via API later.
      // For now, just check if email is in known admin list via a separate endpoint.
      // Simpler: show Discover XHR only if user belongs to default/admin tenant.
      // (default tenant is the admin's, customers have other tenant_ids)
      if (j.user.tenant_id === 'default' || j.user.tenant_id === 'tuantran') {
        $('navDiscover').style.display = '';
      }
    }
  }).catch(()=>{});

// ── init
const _h = parseHash();
// Legacy redirects: old hashes (Telegram alerts #kanban?lead=585,
// bookmarks to #leads) → new Stream tab.
const LEGACY_MAP = {
  posts:    { view: 'stream' },
  leads:    { view: 'stream', _status: 'leads' },
  kanban:   { view: 'stream', _status: 'leads', _board: true },
  login:    { view: 'setup' },                                    // → Connection
  settings: { view: 'setup', _section: 'config' },                // → Config
  etl:      { view: 'setup', _section: 'activity' },              // → Activity
  comments: { view: 'stream' },                                    // gỡ tab Comments
};
let initial = _h.view;
if (LEGACY_MAP[initial]) {
  const m = LEGACY_MAP[initial];
  if (m._status)  _h.params.set('status',  m._status);
  if (m._board)   _h.params.set('view',    'board');
  if (m._section) _h.params.set('section', m._section);
  initial = m.view;
  const qs = _h.params.toString();
  history.replaceState(null, '', qs ? '#' + initial + '?' + qs : '#' + initial);
}
switchView(TITLES[initial] ? initial : 'dashboard');
// Deep-link: if hash carries lead=<id> (e.g. from Telegram "📊 Cập nhật stage"
// button), open the detail panel after the view loads.
const _leadId = _h.params.get('lead');
if (_leadId) setTimeout(() => window.viewLead(Number(_leadId)), 400);

// Hash change: handles browser back/forward + manual URL edits.
window.addEventListener('hashchange', () => {
  const h = parseHash();
  let view = h.view;
  if (LEGACY_MAP[view]) view = LEGACY_MAP[view].view;
  if (TITLES[view]) switchView(view);
});
// Kick off global agent polling immediately so even users who never click the
// FB Login tab get button states synced + see the "Đang crawl" indicator.
if (typeof startAgentPolling === 'function') { window._globalPollStarted = true; startAgentPolling(); }
setInterval(() => { if (parseHash().view === 'dashboard') { loadDashboard(); loadDashStatus(); } }, 15000);
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function shutdown(sig: string) {
  console.log(`server shutting down (${sig})`);
  try { await app.close(); } catch {}
  await closeBrowserContext();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function start(): Promise<void> {
  await registerAuthPlugins(app);
  await registerAuthRoutes(app);
  await registerAuthPages(app);
  await registerAdmin(app);
  await registerAgentRoutes(app);
  await registerAgentUploadRoutes(app);
  await registerAgentDashboardRoutes(app);
  const { registerTelegramWebhook } = await import('./telegram/webhook.js');
  await registerTelegramWebhook(app);

  // Serve the agent tarball at /agent/latest.tgz from data/dist/.
  // Public — no auth needed (the tarball is what install.sh fetches).
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, {
    root: resolvePath(process.cwd(), 'data/dist'),
    prefix: '/agent/',
    decorateReply: false,
  });
  // Public static dir for compiled CSS, favicon, etc.
  await app.register(fastifyStatic, {
    root: resolvePath(process.cwd(), 'public'),
    prefix: '/public/',
    decorateReply: false,
  });
  // Inline-SVG favicon — avoids needing a real file + 404s.
  app.get('/favicon.ico', async (_req, reply) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><text x="50%" y="56%" font-family="Inter,sans-serif" font-size="36" font-weight="700" text-anchor="middle" fill="#fff" dominant-baseline="middle">af</text></svg>';
    reply.header('cache-control', 'public, max-age=86400');
    reply.type('image/svg+xml').send(svg);
  });

  // Global auth gate. Runs after cookie/rate-limit plugins, so req.cookies is populated.
  // Skip /auth/*; for everything else require a valid session — 401 for /api/*, redirect for HTML.
  // Internal callers (scheduler.ts) bypass via Authorization: Bearer $INTERNAL_API_TOKEN
  // and run as the configured DEFAULT_TENANT_ID (Phase A single-tenant).
  // Customer agents authenticate via Authorization: Bearer <license_key> on /api/agent/*.
  const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
  const INTERNAL_TENANT = process.env.DEFAULT_TENANT_ID ?? 'tuantran';
  // Public paths (no auth needed). `/` is special: serves landing for anon, dashboard for authed.
  const PUBLIC_PATHS = new Set(['/', '/install.sh', '/favicon.ico']);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/auth/')) return;
    if (path.startsWith('/agent/')) return; // static tarball — fully public
    if (path.startsWith('/public/')) return; // compiled CSS/assets — fully public
    if (path.startsWith('/api/telegram/wh/')) return; // telegram webhook — auth via secret in URL + header

    // Agent traffic: Bearer license_key on /api/agent/* bypasses session auth.
    if (path.startsWith('/api/agent/')) {
      const ok = await tryAuthAgent(req);
      if (!ok) return reply.status(401).send({ error: 'invalid_license', message: 'License key không hợp lệ' });
      return;
    }

    if (INTERNAL_TOKEN && path.startsWith('/api/')) {
      const auth = req.headers.authorization;
      if (auth === `Bearer ${INTERNAL_TOKEN}`) {
        req.tenant_id = INTERNAL_TENANT;
        req.role = 'system';
        return;
      }
    }

    const sess = await loadSession(req);
    if (sess) {
      req.user_id    = sess.sub;
      req.tenant_id  = sess.tid;
      req.role       = sess.role;
      req.user_email = sess.email;
      req.is_admin   = isAdminEmail(sess.email);
      return;
    }
    if (PUBLIC_PATHS.has(path)) return;
    if (path.startsWith('/api/')) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Cần đăng nhập' });
    }
    return reply.redirect('/auth/login');
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`server on http://${HOST}:${PORT}`);

  // Weekly comment-insights cron — Sunday 08:00 Asia/Ho_Chi_Minh.
  // Runs per-tenant analyzer (uses Gemini to summarize HR + Fulfill themes).
  const cron = await import('node-cron');
  cron.schedule('0 8 * * 0', () => {
    void runWeeklyInsightsAllTenants()
      .then((r) => console.log('[insights] weekly run:', JSON.stringify(r)))
      .catch((e) => console.error('[insights] weekly run failed:', e?.message ?? e));
  }, { timezone: 'Asia/Ho_Chi_Minh' });
  console.log('[insights] weekly cron armed (Sunday 08:00 ICT)');

  // Agent health check — every 5 min. Sends Telegram on status transitions
  // (online ↔ stale ↔ offline). Runs in-process so it survives without the
  // separate scheduler.ts daemon.
  const { checkAgentHealth } = await import('./ops/agent_alerts.js');
  cron.schedule('*/5 * * * *', () => {
    void checkAgentHealth()
      .then((r) => { if (r.alerts > 0) console.log(`[ops-alert] checked=${r.checked} alerts=${r.alerts}`); })
      .catch((e) => console.error('[ops-alert] check failed:', e?.message ?? e));
  });
  console.log('[ops-alert] heartbeat staleness cron armed (every 5 min)');

  // Sale-flow: dispatch due posts from fb_post_queue → agent_commands queue.
  // Runs every 30s. Reply commands are dispatched immediately on approve,
  // so this cron only handles scheduled/now posts.
  cron.schedule('*/30 * * * * *', async () => {
    try {
      // For each tenant, pick at most 1 due post (one in-flight per tenant —
      // chrome-profile contention serialized via agent's getRunState().in_flight check).
      const { rows: due } = await pool.query<{ id: number; tenant_id: string; group_id: string; content: string; image_urls: any }>(
        `WITH due AS (
           SELECT DISTINCT ON (tenant_id) id, tenant_id, group_id, content, image_urls
             FROM fb_post_queue
            WHERE status = 'pending' AND schedule_at <= NOW()
            ORDER BY tenant_id, schedule_at ASC
         )
         UPDATE fb_post_queue SET status = 'dispatched', attempts = attempts + 1
          WHERE id IN (SELECT id FROM due)
       RETURNING id, tenant_id, group_id, content, image_urls`,
      );
      for (const p of due) {
        const groupUrl = `https://www.facebook.com/groups/${p.group_id}/`;
        await pool.query(
          `INSERT INTO agent_commands (tenant_id, cmd, payload)
           VALUES ($1, 'post_to_group', $2::jsonb)`,
          [p.tenant_id, JSON.stringify({
            action_id: p.id,
            group_url: groupUrl,
            content:   p.content,
            image_urls: Array.isArray(p.image_urls) ? p.image_urls : [],
          })],
        );
      }
      if (due.length) console.log(`[post-dispatcher] dispatched ${due.length} post(s)`);
    } catch (e: any) {
      console.error('[post-dispatcher] failed:', e?.message ?? e);
    }
  });
  console.log('[post-dispatcher] cron armed (every 30s)');

  // Telegram bot state TTL cleanup (every 10 min).
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { clearExpired } = await import('./telegram/state.js');
      const n = await clearExpired();
      if (n > 0) console.log(`[tg-bot] expired ${n} bot state(s)`);
    } catch (e: any) {
      console.error('[tg-bot] expired cleanup failed:', e?.message ?? e);
    }
  });
  console.log('[tg-bot] state-expiry cron armed (every 10 min)');
}

start().catch((e) => {
  console.error('server failed to start:', e);
  process.exit(1);
});
