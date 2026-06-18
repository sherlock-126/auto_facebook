/**
 * Admin panel — list/create/manage tenants + users + agent provisioning.
 *
 * Gated by ADMIN_EMAILS env. Mounts:
 *   GET  /admin              → HTML page
 *   GET  /api/admin/tenants  → list all tenants + counts + agent status
 *   GET  /api/admin/users    → list all users (joined with tenants)
 *   POST /api/admin/users    → create user (auto-verify, optional welcome email)
 *   POST /api/admin/users/:id/verify          → manually mark email verified
 *   POST /api/admin/users/:id/resend-verify   → re-send verification email
 *   POST /api/admin/users/:id/resend-welcome  → re-send welcome email with install command
 *   POST /api/admin/users/:id/reset-password  → admin sets a temporary password
 *   DELETE /api/admin/tenants/:id             → wipe tenant + cascade (DANGEROUS)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from './db.js';
import { requireAdmin } from './auth/middleware.js';
import { createUserAndTenant, markEmailVerified, findUserByEmail, updatePassword, approveUser, revokeApproval } from './auth/users.js';
import { hashPassword, validatePassword } from './auth/passwords.js';
import { issueToken } from './auth/tokens.js';
import { sendEmail } from './email/resend-client.js';
import { verifyEmailTemplate, welcomeTemplate } from './email/templates.js';
import { randomBytes } from 'node:crypto';

export async function registerAdmin(app: FastifyInstance): Promise<void> {
  // ---- HTML page ----
  app.get('/admin', { preHandler: requireAdmin }, async (_req, reply) => {
    reply.type('text/html').send(renderAdmin());
  });

  // ---- TENANTS LIST ----
  app.get('/api/admin/tenants', { preHandler: requireAdmin }, async () => {
    const { rows } = await pool.query(
      `SELECT
          t.tenant_id, t.name, t.owner_email, t.plan, t.license_key, t.created_at,
          (SELECT count(*)::int FROM users WHERE tenant_id = t.tenant_id) AS user_count,
          (SELECT max(last_login_at) FROM users WHERE tenant_id = t.tenant_id) AS last_login_at,
          (SELECT count(*)::int FROM dim_group WHERE tenant_id = t.tenant_id AND enabled=true) AS enabled_groups,
          (SELECT count(*)::int FROM fact_group_post WHERE tenant_id = t.tenant_id) AS post_count,
          (SELECT count(*)::int FROM fact_lead WHERE tenant_id = t.tenant_id) AS lead_count,
          -- Health/freshness fields (per-tenant operator view).
          ac.status                AS agent_status,
          ac.last_seen_at          AS agent_last_seen,
          ac.agent_version,
          ac.hostname              AS agent_hostname,
          ac.disk_used_pct,
          ac.disk_avail_gb,
          ac.fb_session_alive,
          ac.last_status           AS heartbeat_status,
          ac.health_state,
          (SELECT count(*)::int FROM fact_lead WHERE tenant_id = t.tenant_id AND detected_at > NOW() - INTERVAL '24 hours') AS leads_24h,
          (SELECT count(*)::int FROM fact_group_post WHERE tenant_id = t.tenant_id AND synced_at > NOW() - INTERVAL '24 hours') AS posts_24h,
          (SELECT max(detected_at) FROM fact_lead WHERE tenant_id = t.tenant_id) AS last_lead_at,
          (SELECT COALESCE(SUM((prompt_tokens*0.30 + output_tokens*2.50)/1000000), 0)::numeric(10,4)
             FROM gemini_usage WHERE tenant_id = t.tenant_id AND called_at > NOW() - INTERVAL '24 hours') AS gemini_cost_24h_usd,
          ts.config->>'gemini_api_key' IS NOT NULL AS has_own_gemini_key,
          ts.config->>'telegram_bot_token' IS NOT NULL AS has_telegram
        FROM tenants t
        LEFT JOIN agent_connections ac USING (tenant_id)
        LEFT JOIN tenant_settings   ts USING (tenant_id)
        ORDER BY t.created_at DESC`
    );
    return { rows };
  });

  // ---- USERS LIST ----
  // Order: pending approval (verified but not approved) first, then approved by recency, then not verified.
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    const { rows } = await pool.query(
      `SELECT
          u.user_id, u.email, u.role, u.tenant_id,
          u.email_verified_at, u.approved_at, u.approved_by,
          u.last_login_at, u.created_at,
          t.name AS tenant_name, t.plan, t.license_key
        FROM users u
        JOIN tenants t USING (tenant_id)
        ORDER BY
          (u.email_verified_at IS NOT NULL AND u.approved_at IS NULL) DESC,  -- pending first
          u.created_at DESC`
    );
    return { rows };
  });

  // ---- CREATE USER (admin override; skips signup rate-limit + can auto-verify) ----
  app.post<{ Body: { email: string; password?: string; tenant_name?: string; auto_verify?: boolean; send_welcome?: boolean } }>(
    '/api/admin/users',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const email = (req.body?.email ?? '').trim().toLowerCase();
      if (!email) return reply.status(400).send({ error: 'missing_email' });

      // Generate temporary password if admin didn't supply one
      const password = req.body?.password?.trim() || `Tmp_${cryptoRandom(10)}!`;
      try { validatePassword(password); }
      catch (e: any) { return reply.status(400).send({ error: 'bad_password', message: e?.message }); }

      try {
        const user = await createUserAndTenant({ email, password, tenant_name: req.body?.tenant_name });
        // Admin-created users are trusted: auto-verify + auto-approve unless admin explicitly opts out.
        if (req.body?.auto_verify) {
          await markEmailVerified(user.user_id);
          await approveUser(user.user_id, req.user_email ?? 'admin');
        }

        if (req.body?.send_welcome && req.body?.auto_verify) {
          const tpl = welcomeTemplate({ email: user.email, tenant_id: user.tenant_id, license_key: user.license_key });
          void sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html });
        } else if (!req.body?.auto_verify) {
          // Skip auto-verify → send verify email; user goes through normal pending-approval flow.
          const token = await issueToken(user.user_id, 'verify_email');
          const tpl = verifyEmailTemplate({ email: user.email, token });
          void sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html });
        }

        return {
          ok: true,
          user_id: user.user_id,
          tenant_id: user.tenant_id,
          email: user.email,
          license_key: user.license_key,
          temp_password: req.body?.password ? undefined : password, // only surface when admin let us auto-gen
        };
      } catch (e: any) {
        return reply.status(400).send({ error: 'create_failed', message: e?.message ?? String(e) });
      }
    }
  );

  // ---- MANUAL VERIFY ----
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/verify', { preHandler: requireAdmin }, async (req) => {
    await markEmailVerified(req.params.id);
    return { ok: true };
  });

  // ---- APPROVE (gives the user permission to log in; sends welcome email with license + install) ----
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const adminEmail = req.user_email ?? 'admin';
    await approveUser(req.params.id, adminEmail);
    const { rows } = await pool.query(
      `SELECT u.email, u.tenant_id, t.license_key
         FROM users u JOIN tenants t USING (tenant_id)
        WHERE u.user_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'not_found' });
    const tpl = welcomeTemplate({ email: rows[0].email, tenant_id: rows[0].tenant_id, license_key: rows[0].license_key });
    const res = await sendEmail({ to: rows[0].email, subject: tpl.subject, html: tpl.html });
    return { ok: true, email_sent: res.ok, email_id: res.id };
  });

  // ---- REVOKE APPROVAL (block future logins; existing sessions still valid until cookie TTL) ----
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/revoke', { preHandler: requireAdmin }, async (req) => {
    await revokeApproval(req.params.id);
    return { ok: true };
  });

  // ---- RESEND VERIFY EMAIL ----
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/resend-verify', { preHandler: requireAdmin }, async (req, reply) => {
    const { rows } = await pool.query('SELECT email FROM users WHERE user_id = $1', [req.params.id]);
    if (!rows[0]) return reply.status(404).send({ error: 'not_found' });
    const token = await issueToken(req.params.id, 'verify_email');
    const tpl = verifyEmailTemplate({ email: rows[0].email, token });
    const res = await sendEmail({ to: rows[0].email, subject: tpl.subject, html: tpl.html });
    return { ok: res.ok, email_id: res.id };
  });

  // ---- RESEND WELCOME EMAIL (with install command) ----
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/resend-welcome', { preHandler: requireAdmin }, async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT u.email, u.tenant_id, t.license_key
         FROM users u JOIN tenants t USING (tenant_id)
        WHERE u.user_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'not_found' });
    const tpl = welcomeTemplate({ email: rows[0].email, tenant_id: rows[0].tenant_id, license_key: rows[0].license_key });
    const res = await sendEmail({ to: rows[0].email, subject: tpl.subject, html: tpl.html });
    return { ok: res.ok, email_id: res.id };
  });

  // ---- RESET PASSWORD (admin sets a new one; returns the plaintext once) ----
  app.post<{ Params: { id: string }; Body?: { password?: string } }>(
    '/api/admin/users/:id/reset-password',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const password = req.body?.password?.trim() || `Tmp_${cryptoRandom(10)}!`;
      try { validatePassword(password); }
      catch (e: any) { return reply.status(400).send({ error: 'bad_password', message: e?.message }); }
      const hash = await hashPassword(password);
      await updatePassword(req.params.id, hash);
      return { ok: true, new_password: password };
    }
  );

  // ---- DELETE TENANT (cascades users + data via FK) ----
  app.delete<{ Params: { id: string } }>('/api/admin/tenants/:id', { preHandler: requireAdmin }, async (req, reply) => {
    if (req.params.id === 'default') return reply.status(400).send({ error: 'cannot_delete_default' });
    const { rowCount } = await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [req.params.id]);
    return { ok: true, deleted: rowCount ?? 0 };
  });

  // ---- RESET AGENT FINGERPRINT ----
  // Clears the hostname lock so the customer's next heartbeat re-pins to
  // whichever VPS they're now running on. Use when a customer legitimately
  // migrates VPS.
  app.post<{ Params: { id: string } }>('/api/admin/tenants/:id/reset-fingerprint', { preHandler: requireAdmin }, async (req) => {
    const { rowCount } = await pool.query(
      'UPDATE agent_connections SET hostname = NULL WHERE tenant_id = $1',
      [req.params.id],
    );
    return { ok: true, reset: (rowCount ?? 0) > 0 };
  });
}

function cryptoRandom(n: number): string {
  // Simple readable random — letters + digits, no ambiguous chars
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const buf = randomBytes(n);
  for (let i = 0; i < n; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

// =====================================================================
// HTML page — single-page, three tabs (Tenants / Users / Create), dark theme
// =====================================================================
function renderAdmin(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · nextclaw</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0E1430; --ink-2:#131A3B; --text:#EAEDF7; --muted:#9AA3C7; --noise:#525a82;
    --signal:#C2F24A; --signal-ink:#0E1430; --mint:#7CE3C4; --line:#242C57;
    --display:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;
    --body:'Inter',ui-sans-serif,system-ui,sans-serif;
    --mono:'Space Mono',ui-monospace,monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: var(--body); background: var(--ink); color: var(--text);
    background-image: radial-gradient(900px 520px at 50% -12%, rgba(194,242,74,.06), transparent 60%); -webkit-font-smoothing: antialiased; }

  header { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--ink-2); }
  header h1 { font-family: var(--display); font-size: 16px; margin: 0; font-weight: 700; letter-spacing: -.02em; display: flex; align-items: center; gap: 8px; }
  header h1 .mark { color: var(--signal); }
  header h1 small { color: var(--noise); font-family: var(--mono); font-size: 11px; font-weight: 400; margin-left: 8px; letter-spacing: .05em; }
  header a { color: var(--mint); text-decoration: none; font-size: 13px; margin-left: 16px; }
  header a:hover { text-decoration: underline; }

  .tabs { display: flex; padding: 0 24px; border-bottom: 1px solid var(--line); background: var(--ink-2); }
  .tabs button { background: transparent; border: 0; color: var(--muted); font-family: var(--body); font-size: 13px; padding: 12px 18px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tabs button:hover { color: var(--text); }
  .tabs button.active { color: var(--text); border-bottom-color: var(--signal); }

  main { padding: 24px; max-width: 1400px; margin: 0 auto; }
  .tab { display: none; }
  .tab.active { display: block; }

  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 12px; }
  .toolbar h2 { margin: 0; font-size: 18px; font-family: var(--display); font-weight: 600; letter-spacing: -.02em; }
  .toolbar .count { font-size: 12px; color: var(--muted); font-family: var(--mono); }
  button.btn, .btn { padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 0; font-family: var(--body); transition: transform .12s ease, filter .15s; }
  .btn:hover { transform: translateY(-1px); filter: brightness(1.04); }
  .btn-primary { background: var(--signal); color: var(--signal-ink); }
  .btn-danger { background: rgba(255,120,130,.1); color: #ff9aa3; border: 1px solid rgba(255,120,130,.25); }
  .btn-ghost { background: var(--ink); color: var(--text); border: 1px solid var(--line); }
  .btn-ghost:hover { border-color: var(--noise); }

  table { width: 100%; border-collapse: collapse; background: var(--ink-2); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); font-weight: 600; font-family: var(--mono); letter-spacing: .04em; padding: 10px 12px; background: var(--ink); border-bottom: 1px solid var(--line); }
  td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  tr:hover td { background: rgba(255,255,255,.02); }
  td.muted { color: var(--muted); }
  code { font-family: var(--mono); font-size: 11px; background: var(--ink); padding: 2px 6px; border-radius: 4px; color: var(--mint); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-family: var(--mono); background: var(--ink); color: var(--muted); border: 1px solid var(--line); }
  .pill-ok { background: rgba(124,227,196,.1); color: var(--mint); border-color: rgba(124,227,196,.3); }
  .pill-warn { background: rgba(255,224,166,.08); color: #ffe0a6; border-color: rgba(255,224,166,.25); }
  .pill-err { background: rgba(255,120,130,.08); color: #ff9aa3; border-color: rgba(255,120,130,.25); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { font-size: 11px; padding: 4px 8px; }

  /* Create form */
  .form-card { background: var(--ink-2); border: 1px solid var(--line); border-radius: 12px; padding: 22px; max-width: 520px; }
  .form-card label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; font-weight: 500; }
  .form-card input { width: 100%; background: var(--ink); color: var(--text); border: 1px solid var(--line); border-radius: 9px; padding: 10px 13px; font-size: 14px; font-family: var(--body); }
  .form-card input::placeholder { color: var(--noise); }
  .form-card input:focus { outline: none; border-color: var(--signal); box-shadow: 0 0 0 3px rgba(194,242,74,.12); }
  .form-card .row { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; color: var(--text); }
  .form-card .row input[type=checkbox] { width: auto; accent-color: var(--signal); }
  .form-card .hint { font-size: 11px; color: var(--noise); margin-top: 4px; }
  .form-card button { margin-top: 18px; width: 100%; padding: 12px; }

  #toast { position: fixed; top: 16px; right: 16px; padding: 12px 16px; border-radius: 9px; font-size: 13px; max-width: 380px; display: none; font-family: var(--body); }
  #toast.show { display: block; }
  #toast.ok { background: rgba(124,227,196,.1); color: var(--mint); border: 1px solid rgba(124,227,196,.3); }
  #toast.err { background: rgba(255,120,130,.08); color: #ff9aa3; border: 1px solid rgba(255,120,130,.25); }

  #result-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); align-items: center; justify-content: center; z-index: 100; }
  #result-modal.show { display: flex; }
  #result-modal .box { background: var(--ink-2); border: 1px solid var(--line); border-radius: 16px; padding: 26px; max-width: 520px; width: 90%; box-shadow: 0 30px 80px -40px rgba(0,0,0,.7); }
  #result-modal h3 { margin: 0 0 14px; font-size: 18px; font-family: var(--display); font-weight: 600; letter-spacing: -.02em; }
  #result-modal .field { margin: 10px 0; font-size: 13px; }
  #result-modal .field label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; font-family: var(--mono); letter-spacing: .04em; margin-bottom: 4px; }
  #result-modal .field .val { background: var(--ink); padding: 8px 10px; border-radius: 6px; font-family: var(--mono); font-size: 12px; word-break: break-all; color: var(--mint); }
</style>
</head><body>

<header>
  <h1><span class="mark">&#9670;</span>nextclaw <small>· admin</small></h1>
  <div>
    <a href="/">← Dashboard</a>
    <a href="#" id="logoutBtn">Log out</a>
  </div>
</header>

<div class="tabs">
  <button data-tab="tenants" class="active">Tenants</button>
  <button data-tab="users">Users</button>
  <button data-tab="create">+ New user</button>
</div>

<main>

<div class="tab active" id="tab-tenants">
  <div class="toolbar">
    <h2>Tenants</h2>
    <div><span class="count" id="tenantsCount">…</span> <button class="btn btn-ghost" onclick="loadTenants()">↻ Refresh</button></div>
  </div>
  <table>
    <thead><tr>
      <th>Tenant</th>
      <th title="Agent online/stale/offline + heartbeat freshness">Agent</th>
      <th title="FB account session alive (false = needs re-login via noVNC)">FB</th>
      <th title="Disk used % on the VPS agent">Disk</th>
      <th title="Groups currently enabled for crawling">Groups</th>
      <th title="Leads detected in the last 24h">Leads 24h</th>
      <th title="Most recent lead">Last lead</th>
      <th title="Estimated Gemini cost, last 24h (USD)">Gemini $</th>
      <th title="Own Gemini key / Telegram bot configured">Cfg</th>
      <th>Health</th>
      <th></th>
    </tr></thead>
    <tbody id="tenantsBody"><tr><td colspan="11" class="muted">Loading…</td></tr></tbody>
  </table>
</div>

<div class="tab" id="tab-users">
  <div class="toolbar">
    <h2>Users</h2>
    <div><span class="count" id="usersCount">…</span> <button class="btn btn-ghost" onclick="loadUsers()">↻ Refresh</button></div>
  </div>
  <table>
    <thead><tr>
      <th>Email</th><th>Workspace</th><th>Role</th><th>Email verified</th><th>Activation</th><th>Last login</th><th>Created</th><th>License</th><th></th>
    </tr></thead>
    <tbody id="usersBody"><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
  </table>
</div>

<div class="tab" id="tab-create">
  <div class="toolbar"><h2>New user (skip signup flow)</h2></div>
  <div class="form-card">
    <form id="createForm">
      <label>Email <span style="color:#ff9aa3;">*</span></label>
      <input name="email" type="email" required placeholder="customer@example.com">

      <label>Workspace name</label>
      <input name="tenant_name" placeholder="(blank = derived from email)">

      <label>Password</label>
      <input name="password" type="text" placeholder="(blank = auto-generate a temporary password)">
      <div class="hint">At least 8 characters if you set one</div>

      <div class="row">
        <input type="checkbox" id="auto_verify" name="auto_verify" checked>
        <label for="auto_verify" style="margin: 0;">Auto-verify email (skip the link-click step)</label>
      </div>

      <div class="row">
        <input type="checkbox" id="send_welcome" name="send_welcome" checked>
        <label for="send_welcome" style="margin: 0;">Send welcome email with license + install command</label>
      </div>

      <button class="btn btn-primary" type="submit" id="createBtn">Create user</button>
    </form>
  </div>
</div>

</main>

<div id="toast"></div>

<div id="result-modal">
  <div class="box">
    <h3>✅ User created</h3>
    <div class="field"><label>Email</label><div class="val" id="r-email"></div></div>
    <div class="field"><label>Tenant ID (workspace)</label><div class="val" id="r-tenant"></div></div>
    <div class="field"><label>License key</label><div class="val" id="r-license"></div></div>
    <div class="field" id="r-pwd-wrap"><label>Temporary password (shown once)</label><div class="val" id="r-pwd"></div></div>
    <div style="margin-top: 18px; display: flex; gap: 10px;">
      <button class="btn btn-ghost" onclick="document.getElementById('result-modal').classList.remove('show')">Close</button>
      <button class="btn btn-primary" onclick="copyAll()">📋 Copy info</button>
    </div>
  </div>
</div>

<script>
function toast(type, text, ms) {
  var el = document.getElementById('toast');
  el.className = 'show ' + type;
  el.textContent = text;
  setTimeout(function() { el.className = ''; }, ms || 4000);
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtDate(d) {
  if (!d) return '<span class="muted">—</span>';
  var dt = new Date(d);
  if (isNaN(dt)) return esc(d);
  return dt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

// Agent status pill — computed from last_seen_at age (thresholds mirror
// src/agent/status.ts: online ≤ 180s, stale ≤ 900s, else offline).
function renderAgentPill(lastSeenAt) {
  if (!lastSeenAt) return '<span class="pill">⚪ not installed</span>';
  var t = new Date(lastSeenAt);
  if (isNaN(t)) return '<span class="pill">⚪ not installed</span>';
  var ageSec = Math.round((Date.now() - t.getTime()) / 1000);
  var ageTxt = ageSec < 60 ? ageSec + 's ago'
             : ageSec < 3600 ? Math.round(ageSec / 60) + 'm ago'
             : Math.round(ageSec / 3600) + 'h ago';
  if (ageSec <= 180) return '<span class="pill pill-ok" title="Last seen ' + esc(lastSeenAt) + '">🟢 online · ' + ageTxt + '</span>';
  if (ageSec <= 900) return '<span class="pill pill-warn" title="Last seen ' + esc(lastSeenAt) + '">🟡 stale · ' + ageTxt + '</span>';
  return '<span class="pill pill-err" title="Last seen ' + esc(lastSeenAt) + '">🔴 offline · ' + ageTxt + '</span>';
}

// Tab switching
document.querySelectorAll('.tabs button').forEach(function(b) {
  b.addEventListener('click', function() {
    var name = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(function(x) { x.classList.toggle('active', x === b); });
    document.querySelectorAll('.tab').forEach(function(x) { x.classList.toggle('active', x.id === 'tab-' + name); });
    if (name === 'tenants') loadTenants();
    if (name === 'users') loadUsers();
  });
});

// Logout
document.getElementById('logoutBtn').addEventListener('click', function(e) {
  e.preventDefault();
  fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function() {
    location.href = '/auth/login';
  });
});

// ---- Tenants ----
async function loadTenants() {
  var body = document.getElementById('tenantsBody');
  body.innerHTML = '<tr><td colspan="11" class="muted">Loading…</td></tr>';
  try {
    var r = await fetch('/api/admin/tenants', { credentials: 'same-origin' });
    var j = await r.json();
    document.getElementById('tenantsCount').textContent = j.rows.length + ' tenants';
    if (!j.rows.length) { body.innerHTML = '<tr><td colspan="11" class="muted">No tenants yet</td></tr>'; return; }
    body.innerHTML = j.rows.map(function(t) {
      var agent = renderAgentPill(t.agent_last_seen);
      // FB session pill: green if alive, red if dead, gray if unknown.
      var fb = t.fb_session_alive === true  ? '<span class="pill" style="background:#22c55e">✓</span>'
             : t.fb_session_alive === false ? '<span class="pill" style="background:#ef4444">✗ dead</span>'
             : '<span class="pill">—</span>';
      // Disk pill: yellow >70, red >85.
      var disk = t.disk_used_pct == null ? '<span class="muted">—</span>'
               : (t.disk_used_pct >= 85 ? '<span class="pill" style="background:#ef4444">' + t.disk_used_pct + '%</span>'
               :  t.disk_used_pct >= 70 ? '<span class="pill" style="background:#eab308">' + t.disk_used_pct + '%</span>'
               :  '<span>' + t.disk_used_pct + '%</span>');
      var lastLead = t.last_lead_at ? fmtDate(t.last_lead_at) : '<span class="muted">never</span>';
      var cost = t.gemini_cost_24h_usd ? '$' + Number(t.gemini_cost_24h_usd).toFixed(4) : '<span class="muted">$0</span>';
      var cfg = (t.has_own_gemini_key ? '🔑' : '') + (t.has_telegram ? '📱' : '');
      // Health flags from health_state JSONB.
      var hs = t.health_state || {};
      var healthBits = [];
      if (hs.session === 'dead') healthBits.push('💀 sess');
      if (hs.disk    === 'full') healthBits.push('💽 disk');
      if (t.heartbeat_status === 'offline') healthBits.push('🚨 hb');
      var health = healthBits.length ? '<span style="color:#ef4444">' + healthBits.join(' ') + '</span>' : '<span style="color:#22c55e">✓</span>';
      return '<tr>' +
        '<td><strong>' + esc(t.name) + '</strong><br><code>' + esc(t.tenant_id) + '</code><br><span class="muted">' + esc(t.owner_email || '') + '</span></td>' +
        '<td>' + agent + (t.agent_hostname ? '<br><code class="muted" style="font-size:11px;">'+esc(t.agent_hostname)+'</code>' : '') + '</td>' +
        '<td>' + fb + '</td>' +
        '<td>' + disk + '</td>' +
        '<td>' + (t.enabled_groups || 0) + '</td>' +
        '<td>' + (t.leads_24h || 0) + '</td>' +
        '<td class="muted" style="font-size:11px;">' + lastLead + '</td>' +
        '<td>' + cost + '</td>' +
        '<td>' + cfg + '</td>' +
        '<td>' + health + '</td>' +
        '<td class="actions"><button class="btn btn-danger" onclick="deleteTenant(\\''+ esc(t.tenant_id) +'\\', \\'' + esc(t.name) + '\\')">Delete</button></td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="11" class="muted">Error: ' + esc(e.message) + '</td></tr>';
  }
}

async function deleteTenant(id, name) {
  if (id === 'default') { toast('err', 'Cannot delete the default tenant'); return; }
  if (id === 'tuantran') { if (!confirm('WARNING: this is the primary tenant. Delete anyway?')) return; }
  if (!confirm('Delete tenant "' + name + '" (' + id + ')? This wipes all data and users.')) return;
  try {
    var r = await fetch('/api/admin/tenants/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
    var j = await r.json();
    if (j.ok) { toast('ok', 'Deleted tenant ' + id); loadTenants(); }
    else { toast('err', j.message || 'Delete failed'); }
  } catch (e) { toast('err', e.message); }
}

// ---- Users ----
async function loadUsers() {
  var body = document.getElementById('usersBody');
  body.innerHTML = '<tr><td colspan="9" class="muted">Loading…</td></tr>';
  try {
    var r = await fetch('/api/admin/users', { credentials: 'same-origin' });
    var j = await r.json();
    var pending = j.rows.filter(function(u){ return u.email_verified_at && !u.approved_at; }).length;
    document.getElementById('usersCount').textContent = j.rows.length + ' users' + (pending ? ' · ' + pending + ' awaiting activation' : '');
    if (!j.rows.length) { body.innerHTML = '<tr><td colspan="9" class="muted">No users yet</td></tr>'; return; }
    body.innerHTML = j.rows.map(function(u) {
      var verifyPill = u.email_verified_at
        ? '<span class="pill pill-ok">✓ ' + fmtDate(u.email_verified_at) + '</span>'
        : '<span class="pill pill-warn">⏳ not verified</span>';
      var approvalPill;
      var rowHighlight = '';
      if (u.approved_at) {
        approvalPill = '<span class="pill pill-ok">✓ ' + fmtDate(u.approved_at) + '</span>'
                     + (u.approved_by ? '<br><span class="muted" style="font-size:10px;">by ' + esc(u.approved_by) + '</span>' : '');
      } else if (u.email_verified_at) {
        approvalPill = '<span class="pill pill-warn">⏳ Awaiting activation</span>';
        rowHighlight = ' style="background:rgba(194,242,74,.05);"';
      } else {
        approvalPill = '<span class="pill">— (verify email first)</span>';
      }

      var actions = '';
      if (!u.email_verified_at) {
        actions += '<button class="btn btn-primary" onclick="verifyUser(\\''+ esc(u.user_id) +'\\')">✓ Verify</button>';
        actions += '<button class="btn btn-ghost" onclick="resendVerify(\\''+ esc(u.user_id) +'\\')">↺ Verify email</button>';
      } else if (!u.approved_at) {
        actions += '<button class="btn btn-primary" onclick="approveUser(\\''+ esc(u.user_id) +'\\', \\''+ esc(u.email) +'\\')">✓ Activate (paid) — sends license + install</button>';
      } else {
        actions += '<button class="btn btn-ghost" onclick="resendWelcome(\\''+ esc(u.user_id) +'\\')">↺ Welcome</button>';
        actions += '<button class="btn btn-ghost" onclick="revokeUser(\\''+ esc(u.user_id) +'\\', \\''+ esc(u.email) +'\\')">⛔ Revoke</button>';
      }
      actions += '<button class="btn btn-ghost" onclick="resetPwd(\\''+ esc(u.user_id) +'\\', \\''+ esc(u.email) +'\\')">🔑 Reset pwd</button>';

      return '<tr' + rowHighlight + '>' +
        '<td><strong>' + esc(u.email) + '</strong></td>' +
        '<td>' + esc(u.tenant_name) + '<br><code>' + esc(u.tenant_id) + '</code></td>' +
        '<td><span class="pill">' + esc(u.role) + '</span></td>' +
        '<td>' + verifyPill + '</td>' +
        '<td>' + approvalPill + '</td>' +
        '<td class="muted">' + fmtDate(u.last_login_at) + '</td>' +
        '<td class="muted">' + fmtDate(u.created_at) + '</td>' +
        '<td><code style="font-size:10px;">' + esc((u.license_key || '').slice(0, 24)) + '…</code></td>' +
        '<td class="actions">' + actions + '</td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="9" class="muted">Error: ' + esc(e.message) + '</td></tr>';
  }
}

async function verifyUser(id) {
  var r = await fetch('/api/admin/users/' + id + '/verify', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) { toast('ok', 'Verified'); loadUsers(); } else { toast('err', j.message || 'Error'); }
}
async function approveUser(id, email) {
  if (!confirm('Activate ' + email + '? This sends the welcome email with the license key + agent install command.')) return;
  var r = await fetch('/api/admin/users/' + id + '/approve', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) {
    toast('ok', '✅ Activated' + (j.email_sent ? ' + welcome email sent' : ' (email send failed)'));
    loadUsers();
  } else { toast('err', j.message || 'Activation failed'); }
}
async function revokeUser(id, email) {
  if (!confirm('Revoke access for ' + email + '? They will no longer be able to log in.')) return;
  var r = await fetch('/api/admin/users/' + id + '/revoke', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) { toast('ok', '⛔ Revoked'); loadUsers(); } else { toast('err', j.message || 'Error'); }
}
async function resendVerify(id) {
  var r = await fetch('/api/admin/users/' + id + '/resend-verify', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) toast('ok', 'Verification email resent' + (j.email_id ? ' (' + j.email_id.slice(0,8) + '…)' : ''));
  else toast('err', j.message || 'Send failed');
}
async function resendWelcome(id) {
  var r = await fetch('/api/admin/users/' + id + '/resend-welcome', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) toast('ok', 'Welcome email resent' + (j.email_id ? ' (' + j.email_id.slice(0,8) + '…)' : ''));
  else toast('err', j.message || 'Send failed');
}
async function resetPwd(id, email) {
  if (!confirm('Reset the password for ' + email + '? A temporary password will be generated.')) return;
  var r = await fetch('/api/admin/users/' + id + '/reset-password', { method: 'POST', credentials: 'same-origin', headers: {'content-type':'application/json'}, body: '{}' });
  var j = await r.json();
  if (j.ok) {
    prompt('New password (copy now, not shown again):', j.new_password);
  } else { toast('err', j.message || 'Reset failed'); }
}

// ---- Create user form ----
var _resultData = null;
document.getElementById('createForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var btn = document.getElementById('createBtn'); btn.disabled = true; btn.textContent = '⏳ Creating…';
  var f = e.target;
  var body = {
    email: f.email.value,
    tenant_name: f.tenant_name.value || undefined,
    password: f.password.value || undefined,
    auto_verify: f.auto_verify.checked,
    send_welcome: f.send_welcome.checked,
  };
  try {
    var r = await fetch('/api/admin/users', { method: 'POST', credentials: 'same-origin', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    var j = await r.json();
    if (j.ok) {
      _resultData = j;
      document.getElementById('r-email').textContent   = j.email;
      document.getElementById('r-tenant').textContent  = j.tenant_id;
      document.getElementById('r-license').textContent = j.license_key;
      if (j.temp_password) {
        document.getElementById('r-pwd').textContent   = j.temp_password;
        document.getElementById('r-pwd-wrap').style.display = '';
      } else {
        document.getElementById('r-pwd-wrap').style.display = 'none';
      }
      document.getElementById('result-modal').classList.add('show');
      f.reset();
      f.auto_verify.checked = true; f.send_welcome.checked = true;
    } else {
      toast('err', '❌ ' + (j.message || 'Create failed'));
    }
  } catch (e) { toast('err', '❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Create user'; }
});

function copyAll() {
  if (!_resultData) return;
  var lines = [
    'Email: ' + _resultData.email,
    'Tenant: ' + _resultData.tenant_id,
    'License: ' + _resultData.license_key,
  ];
  if (_resultData.temp_password) lines.push('Password (temporary): ' + _resultData.temp_password);
  navigator.clipboard.writeText(lines.join('\\n')).then(function() { toast('ok', 'Copied'); });
}

// Initial load
loadTenants();
</script>
</body></html>`;
}
