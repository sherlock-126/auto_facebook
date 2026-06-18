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
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · fb.autonow.vn</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b1020; color: #e8ecf3; }

  header { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; border-bottom: 1px solid #1c2546; background: #0e1530; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header h1 small { color: #8a96bd; font-size: 11px; font-weight: 400; margin-left: 8px; }
  header a { color: #7ea7ff; text-decoration: none; font-size: 13px; margin-left: 16px; }
  header a:hover { text-decoration: underline; }

  .tabs { display: flex; padding: 0 24px; border-bottom: 1px solid #1c2546; background: #0e1530; }
  .tabs button { background: transparent; border: 0; color: #a9b3d1; font: inherit; padding: 12px 18px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 13px; }
  .tabs button:hover { color: #e8ecf3; }
  .tabs button.active { color: #fff; border-bottom-color: #3b6ef0; }

  main { padding: 24px; max-width: 1400px; margin: 0 auto; }
  .tab { display: none; }
  .tab.active { display: block; }

  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 12px; }
  .toolbar h2 { margin: 0; font-size: 18px; }
  .toolbar .count { font-size: 12px; color: #8a96bd; }
  button.btn, .btn { padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 0; font-family: inherit; }
  .btn-primary { background: #3b6ef0; color: #fff; }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-danger { background: #b03a4a; color: #fff; }
  .btn-ghost { background: #1c2546; color: #cad3ed; }
  .btn-ghost:hover { background: #232d56; }

  table { width: 100%; border-collapse: collapse; background: #131a33; border: 1px solid #222a4a; border-radius: 8px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #8a96bd; font-weight: 600; padding: 10px 12px; background: #0e1530; border-bottom: 1px solid #1c2546; }
  td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #1c2546; vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  tr:hover td { background: #161e3a; }
  td.muted { color: #8a96bd; }
  code { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; background: #0a0f24; padding: 2px 6px; border-radius: 3px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; background: #1c2546; color: #cad3ed; }
  .pill-ok { background: #1f3f2a; color: #9eecbe; }
  .pill-warn { background: #3a2e1c; color: #ffe0a6; }
  .pill-err { background: #3a1c28; color: #ff9aa3; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { font-size: 11px; padding: 4px 8px; }

  /* Create form */
  .form-card { background: #131a33; border: 1px solid #222a4a; border-radius: 8px; padding: 22px; max-width: 520px; }
  .form-card label { display: block; font-size: 12px; color: #a9b3d1; margin: 12px 0 4px; }
  .form-card input { width: 100%; background: #0a0f24; color: #e8ecf3; border: 1px solid #222a4a; border-radius: 5px; padding: 8px 12px; font-size: 14px; font-family: inherit; }
  .form-card input:focus { outline: none; border-color: #3b6ef0; }
  .form-card .row { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; color: #cad3ed; }
  .form-card .row input[type=checkbox] { width: auto; }
  .form-card .hint { font-size: 11px; color: #8a96bd; margin-top: 4px; }
  .form-card button { margin-top: 18px; width: 100%; padding: 10px; }

  #toast { position: fixed; top: 16px; right: 16px; padding: 12px 16px; border-radius: 6px; font-size: 13px; max-width: 380px; display: none; }
  #toast.show { display: block; }
  #toast.ok { background: #1f3f2a; color: #9eecbe; border: 1px solid #2a5a3b; }
  #toast.err { background: #3a1c28; color: #ff9aa3; border: 1px solid #4a1f24; }

  #result-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); align-items: center; justify-content: center; z-index: 100; }
  #result-modal.show { display: flex; }
  #result-modal .box { background: #131a33; border: 1px solid #2a3560; border-radius: 10px; padding: 26px; max-width: 520px; width: 90%; }
  #result-modal h3 { margin: 0 0 14px; font-size: 18px; }
  #result-modal .field { margin: 10px 0; font-size: 13px; }
  #result-modal .field label { display: block; font-size: 11px; color: #8a96bd; text-transform: uppercase; margin-bottom: 4px; }
  #result-modal .field .val { background: #0a0f24; padding: 8px 10px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
</style>
</head><body>

<header>
  <h1>Admin Panel <small>fb.autonow.vn</small></h1>
  <div>
    <a href="/">← Dashboard</a>
    <a href="#" id="logoutBtn">Đăng xuất</a>
  </div>
</header>

<div class="tabs">
  <button data-tab="tenants" class="active">Tenants</button>
  <button data-tab="users">Users</button>
  <button data-tab="create">+ Tạo user mới</button>
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
      <th title="FB account session alive (false = cần re-login qua noVNC)">FB</th>
      <th title="Disk used % trên VPS agent">Disk</th>
      <th title="Số groups đang enabled crawl">Groups</th>
      <th title="Lead phát hiện 24h qua">Leads 24h</th>
      <th title="Lead gần nhất">Last lead</th>
      <th title="Gemini cost ước tính 24h (USD)">Gemini $</th>
      <th title="Key Gemini riêng / Telegram bot configured">Cfg</th>
      <th>Health</th>
      <th></th>
    </tr></thead>
    <tbody id="tenantsBody"><tr><td colspan="11" class="muted">Đang tải…</td></tr></tbody>
  </table>
</div>

<div class="tab" id="tab-users">
  <div class="toolbar">
    <h2>Users</h2>
    <div><span class="count" id="usersCount">…</span> <button class="btn btn-ghost" onclick="loadUsers()">↻ Refresh</button></div>
  </div>
  <table>
    <thead><tr>
      <th>Email</th><th>Workspace</th><th>Role</th><th>Email verified</th><th>Approval</th><th>Last login</th><th>Tạo</th><th>License</th><th></th>
    </tr></thead>
    <tbody id="usersBody"><tr><td colspan="9" class="muted">Đang tải…</td></tr></tbody>
  </table>
</div>

<div class="tab" id="tab-create">
  <div class="toolbar"><h2>Tạo user mới (skip signup flow)</h2></div>
  <div class="form-card">
    <form id="createForm">
      <label>Email <span style="color:#ff9aa3;">*</span></label>
      <input name="email" type="email" required placeholder="customer@example.com">

      <label>Tên workspace</label>
      <input name="tenant_name" placeholder="(để trống = lấy từ email)">

      <label>Mật khẩu</label>
      <input name="password" type="text" placeholder="(để trống = hệ thống tự tạo password tạm)">
      <div class="hint">Min 8 ký tự nếu nhập</div>

      <div class="row">
        <input type="checkbox" id="auto_verify" name="auto_verify" checked>
        <label for="auto_verify" style="margin: 0;">Auto-verify email (skip bước user phải click link)</label>
      </div>

      <div class="row">
        <input type="checkbox" id="send_welcome" name="send_welcome" checked>
        <label for="send_welcome" style="margin: 0;">Gửi welcome email kèm license + lệnh cài agent</label>
      </div>

      <button class="btn btn-primary" type="submit" id="createBtn">Tạo user</button>
    </form>
  </div>
</div>

</main>

<div id="toast"></div>

<div id="result-modal">
  <div class="box">
    <h3>✅ User đã được tạo</h3>
    <div class="field"><label>Email</label><div class="val" id="r-email"></div></div>
    <div class="field"><label>Tenant ID (workspace)</label><div class="val" id="r-tenant"></div></div>
    <div class="field"><label>License key</label><div class="val" id="r-license"></div></div>
    <div class="field" id="r-pwd-wrap"><label>Mật khẩu tạm (chỉ hiện 1 lần)</label><div class="val" id="r-pwd"></div></div>
    <div style="margin-top: 18px; display: flex; gap: 10px;">
      <button class="btn btn-ghost" onclick="document.getElementById('result-modal').classList.remove('show')">Đóng</button>
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
  return dt.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

// Agent status pill — computed from last_seen_at age (thresholds mirror
// src/agent/status.ts: online ≤ 180s, stale ≤ 900s, else offline).
function renderAgentPill(lastSeenAt) {
  if (!lastSeenAt) return '<span class="pill pill-err">⚪ chưa cài</span>';
  var t = new Date(lastSeenAt);
  if (isNaN(t)) return '<span class="pill pill-err">⚪ chưa cài</span>';
  var ageSec = Math.round((Date.now() - t.getTime()) / 1000);
  var ageTxt = ageSec < 60 ? ageSec + 's trước'
             : ageSec < 3600 ? Math.round(ageSec / 60) + ' phút trước'
             : Math.round(ageSec / 3600) + ' giờ trước';
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
  body.innerHTML = '<tr><td colspan="11" class="muted">Đang tải…</td></tr>';
  try {
    var r = await fetch('/api/admin/tenants', { credentials: 'same-origin' });
    var j = await r.json();
    document.getElementById('tenantsCount').textContent = j.rows.length + ' tenant';
    if (!j.rows.length) { body.innerHTML = '<tr><td colspan="11" class="muted">Chưa có tenant nào</td></tr>'; return; }
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
        '<td class="actions"><button class="btn btn-danger" onclick="deleteTenant(\\''+ esc(t.tenant_id) +'\\', \\'' + esc(t.name) + '\\')">Xoá</button></td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="11" class="muted">Lỗi: ' + esc(e.message) + '</td></tr>';
  }
}

async function deleteTenant(id, name) {
  if (id === 'default') { toast('err', 'Không thể xoá tenant default'); return; }
  if (id === 'tuantran') { if (!confirm('CẢNH BÁO: Đây là tenant chính. Vẫn xoá?')) return; }
  if (!confirm('Xoá tenant "' + name + '" (' + id + ')? Sẽ mất toàn bộ data + users.')) return;
  try {
    var r = await fetch('/api/admin/tenants/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
    var j = await r.json();
    if (j.ok) { toast('ok', 'Đã xoá tenant ' + id); loadTenants(); }
    else { toast('err', j.message || 'Xoá thất bại'); }
  } catch (e) { toast('err', e.message); }
}

// ---- Users ----
async function loadUsers() {
  var body = document.getElementById('usersBody');
  body.innerHTML = '<tr><td colspan="9" class="muted">Đang tải…</td></tr>';
  try {
    var r = await fetch('/api/admin/users', { credentials: 'same-origin' });
    var j = await r.json();
    var pending = j.rows.filter(function(u){ return u.email_verified_at && !u.approved_at; }).length;
    document.getElementById('usersCount').textContent = j.rows.length + ' user' + (pending ? ' · ' + pending + ' chờ duyệt' : '');
    if (!j.rows.length) { body.innerHTML = '<tr><td colspan="9" class="muted">Chưa có user nào</td></tr>'; return; }
    body.innerHTML = j.rows.map(function(u) {
      var verifyPill = u.email_verified_at
        ? '<span class="pill pill-ok">✓ ' + fmtDate(u.email_verified_at) + '</span>'
        : '<span class="pill pill-warn">⏳ chưa verify</span>';
      var approvalPill;
      var rowHighlight = '';
      if (u.approved_at) {
        approvalPill = '<span class="pill pill-ok">✓ ' + fmtDate(u.approved_at) + '</span>'
                     + (u.approved_by ? '<br><span class="muted" style="font-size:10px;">bởi ' + esc(u.approved_by) + '</span>' : '');
      } else if (u.email_verified_at) {
        approvalPill = '<span class="pill pill-warn">⏳ Chờ admin duyệt</span>';
        rowHighlight = ' style="background:#1a2240;"';
      } else {
        approvalPill = '<span class="pill">— (cần verify email trước)</span>';
      }

      var actions = '';
      if (!u.email_verified_at) {
        actions += '<button class="btn btn-primary" onclick="verifyUser(\\''+ esc(u.user_id) +'\\')">✓ Verify</button>';
        actions += '<button class="btn btn-ghost" onclick="resendVerify(\\''+ esc(u.user_id) +'\\')">↺ Verify email</button>';
      } else if (!u.approved_at) {
        actions += '<button class="btn btn-primary" onclick="approveUser(\\''+ esc(u.user_id) +'\\', \\''+ esc(u.email) +'\\')">✓ Duyệt + gửi welcome</button>';
      } else {
        actions += '<button class="btn btn-ghost" onclick="resendWelcome(\\''+ esc(u.user_id) +'\\')">↺ Welcome</button>';
        actions += '<button class="btn btn-ghost" onclick="revokeUser(\\''+ esc(u.user_id) +'\\', \\''+ esc(u.email) +'\\')">⛔ Thu hồi</button>';
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
    body.innerHTML = '<tr><td colspan="9" class="muted">Lỗi: ' + esc(e.message) + '</td></tr>';
  }
}

async function verifyUser(id) {
  var r = await fetch('/api/admin/users/' + id + '/verify', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) { toast('ok', 'Đã verify'); loadUsers(); } else { toast('err', j.message || 'Lỗi'); }
}
async function approveUser(id, email) {
  if (!confirm('Duyệt ' + email + '? Hệ thống sẽ gửi welcome email kèm license + lệnh cài agent.')) return;
  var r = await fetch('/api/admin/users/' + id + '/approve', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) {
    toast('ok', '✅ Đã duyệt' + (j.email_sent ? ' + welcome email đã gửi' : ' (lỗi gửi email)'));
    loadUsers();
  } else { toast('err', j.message || 'Duyệt thất bại'); }
}
async function revokeUser(id, email) {
  if (!confirm('Thu hồi quyền của ' + email + '? User sẽ không login được nữa.')) return;
  var r = await fetch('/api/admin/users/' + id + '/revoke', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) { toast('ok', '⛔ Đã thu hồi'); loadUsers(); } else { toast('err', j.message || 'Lỗi'); }
}
async function resendVerify(id) {
  var r = await fetch('/api/admin/users/' + id + '/resend-verify', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) toast('ok', 'Đã gửi lại email verify' + (j.email_id ? ' (' + j.email_id.slice(0,8) + '…)' : ''));
  else toast('err', j.message || 'Gửi thất bại');
}
async function resendWelcome(id) {
  var r = await fetch('/api/admin/users/' + id + '/resend-welcome', { method: 'POST', credentials: 'same-origin' });
  var j = await r.json();
  if (j.ok) toast('ok', 'Đã gửi lại welcome email' + (j.email_id ? ' (' + j.email_id.slice(0,8) + '…)' : ''));
  else toast('err', j.message || 'Gửi thất bại');
}
async function resetPwd(id, email) {
  if (!confirm('Reset password cho ' + email + '? Hệ thống sẽ tạo mật khẩu tạm.')) return;
  var r = await fetch('/api/admin/users/' + id + '/reset-password', { method: 'POST', credentials: 'same-origin', headers: {'content-type':'application/json'}, body: '{}' });
  var j = await r.json();
  if (j.ok) {
    prompt('Mật khẩu mới (copy ngay, không hiện lại):', j.new_password);
  } else { toast('err', j.message || 'Reset thất bại'); }
}

// ---- Create user form ----
var _resultData = null;
document.getElementById('createForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var btn = document.getElementById('createBtn'); btn.disabled = true; btn.textContent = '⏳ Đang tạo…';
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
      toast('err', '❌ ' + (j.message || 'Tạo thất bại'));
    }
  } catch (e) { toast('err', '❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Tạo user'; }
});

function copyAll() {
  if (!_resultData) return;
  var lines = [
    'Email: ' + _resultData.email,
    'Tenant: ' + _resultData.tenant_id,
    'License: ' + _resultData.license_key,
  ];
  if (_resultData.temp_password) lines.push('Password (tạm): ' + _resultData.temp_password);
  navigator.clipboard.writeText(lines.join('\\n')).then(function() { toast('ok', 'Đã copy'); });
}

// Initial load
loadTenants();
</script>
</body></html>`;
}
