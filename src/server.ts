/**
 * Fastify server: dashboard + login helper + discover mode + admin actions.
 *
 * Login helper opens headed Chrome on Xvfb so the user can drive it through
 * noVNC, then captures and persists storage_state on /api/login/save.
 *
 * Discover mode opens another browser with the saved session and logs every
 * FB API XHR to xhr_capture so the user can identify endpoints to replay.
 */
import 'dotenv/config';
import Fastify from 'fastify';
import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext } from 'playwright';
import { pool } from './db.js';
import { saveSession } from './fb/session.js';
import { runOne } from './etl/runner.js';
import { startDiscover, stopDiscover, listCaptureSummary, getCapture, getDiscoverHandle } from './fb/discover.js';

chromiumExtra.use(stealth());

const PORT = Number(process.env.APP_PORT ?? 4200);
const HOST = process.env.APP_HOST ?? '0.0.0.0';

const app = Fastify({ logger: true });

// ----- login (manual via noVNC) -----
let loginBrowser: Browser | null = null;
let loginContext: BrowserContext | null = null;

app.post('/api/login/start', async () => {
  if (loginContext) return { ok: true, note: 'login session already open' };
  loginBrowser = await chromiumExtra.launch({
    headless: process.env.BROWSER_HEADLESS === 'true',
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  loginContext = await loginBrowser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'vi-VN',
  });
  const page = await loginContext.newPage();
  await page.goto('https://www.facebook.com/login');
  return { ok: true, note: 'Browser opened on Xvfb — connect via noVNC to login' };
});

app.post('/api/login/save', async () => {
  if (!loginContext) return { ok: false, error: 'no login session — call /api/login/start first' };
  const meta = await saveSession(loginContext);
  try { await loginContext.close(); } catch {}
  try { await loginBrowser?.close(); } catch {}
  loginContext = null;
  loginBrowser = null;
  return { ok: true, ...meta };
});

app.post('/api/login/cancel', async () => {
  try { await loginContext?.close(); } catch {}
  try { await loginBrowser?.close(); } catch {}
  loginContext = null;
  loginBrowser = null;
  return { ok: true };
});

// ----- discover mode -----
app.post<{ Body?: { startUrl?: string; label?: string } }>('/api/discover/start', async (req) => {
  return await startDiscover(req.body ?? {});
});
app.post('/api/discover/stop', async () => {
  return await stopDiscover();
});
app.get<{ Querystring: { runId?: string } }>('/api/discover/captures', async (req) => {
  const rows = await listCaptureSummary(req.query.runId);
  const handle = getDiscoverHandle();
  return { runId: handle?.runId ?? null, rows };
});
app.get<{ Params: { id: string } }>('/api/discover/captures/:id', async (req) => {
  const row = await getCapture(Number(req.params.id));
  if (!row) return { ok: false };
  return { ok: true, row };
});

// ----- groups (auto-discovered into dim_group) -----
app.get('/api/groups', async () => {
  const { rows } = await pool.query(
    `SELECT group_id, name, url, privacy, member_count, is_joined, enabled, first_seen_at, updated_at
       FROM dim_group ORDER BY enabled DESC, name`
  );
  return { rows };
});

app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/groups/:id', async (req) => {
  if (typeof req.body.enabled === 'boolean') {
    await pool.query('UPDATE dim_group SET enabled = $1, updated_at = now() WHERE group_id = $2', [req.body.enabled, req.params.id]);
  }
  return { ok: true };
});

// ----- ad-hoc run -----
app.post<{ Body: { entity: string; scope: string; mode?: 'incr' | 'full' } }>('/api/run', async (req) => {
  const { entity, scope, mode } = req.body;
  return await runOne(entity, scope, mode ?? 'incr');
});

// ----- dashboard -----
app.get('/api/dashboard/stats', async () => {
  const [groups, posts, comments, runs, sess] = await Promise.all([
    pool.query('SELECT count(*) FROM dim_group WHERE is_joined = TRUE'),
    pool.query('SELECT count(*) FROM fact_group_post WHERE deleted_at IS NULL'),
    pool.query('SELECT count(*) FROM fact_group_post_comment WHERE deleted_at IS NULL'),
    pool.query(
      `SELECT id, kind, scope, started_at, finished_at, status, rows_upserted, message
         FROM etl_run ORDER BY started_at DESC LIMIT 20`
    ),
    pool.query(`SELECT c_user, created_at FROM fb_session WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`),
  ]);
  return {
    session: sess.rows[0] ?? null,
    counts: {
      groups: Number(groups.rows[0].count),
      posts: Number(posts.rows[0].count),
      comments: Number(comments.rows[0].count),
    },
    recent_runs: runs.rows,
  };
});

// ----- minimal HTML dashboard -----
app.get('/', async (_, reply) => {
  reply.type('text/html').send(`<!doctype html>
<meta charset="utf-8" />
<title>auto_facebook</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; max-width: 1100px; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td, th { border-bottom: 1px solid #eee; padding: 6px; text-align: left; vertical-align: top; }
  .hero { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { padding: 12px; border: 1px solid #ddd; border-radius: 8px; }
  .num { font-size: 24px; font-weight: 600; }
  .ok { color: green; } .error { color: #c00; }
  button { padding: 4px 10px; font-size: 13px; cursor: pointer; }
  .row { margin: 8px 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
</style>
<h1>auto_facebook — joined groups warehouse</h1>
<div class="hero">
  <div class="card"><div>Session</div><div id="c-sess" class="num">–</div></div>
  <div class="card"><div>Joined groups</div><div class="num" id="c-groups">–</div></div>
  <div class="card"><div>Posts</div><div class="num" id="c-posts">–</div></div>
  <div class="card"><div>Comments</div><div class="num" id="c-comments">–</div></div>
</div>

<h2>1. Login</h2>
<div class="row">
  <button onclick="api('/api/login/start','POST').then(j=>alert(JSON.stringify(j)))">Open Chrome (Xvfb)</button>
  <button onclick="api('/api/login/save','POST').then(j=>{alert(JSON.stringify(j));load();})">Save session</button>
  <button onclick="api('/api/login/cancel','POST')">Cancel</button>
  <span>→ then open noVNC in another tab to log in by hand</span>
</div>

<h2>2. Discover XHR endpoints</h2>
<div class="row">
  <button onclick="api('/api/discover/start','POST',{startUrl:'https://www.facebook.com/groups/feed/'}).then(j=>alert(JSON.stringify(j)))">Start discover</button>
  <button onclick="api('/api/discover/stop','POST').then(()=>loadCaps())">Stop discover</button>
  <button onclick="loadCaps()">Refresh captures</button>
  <span>→ browse to a group in noVNC, scroll, expand comments. Then refresh.</span>
</div>
<table id="d-table"><thead><tr><th>friendly_name</th><th>count</th><th>last seen</th><th>sample</th></tr></thead><tbody></tbody></table>

<h2>3. Joined groups (toggle which to scrape)</h2>
<table id="g-table"><thead><tr><th>name</th><th>id</th><th>privacy</th><th>members</th><th>enabled</th><th></th></tr></thead><tbody></tbody></table>

<h2>4. Recent runs</h2>
<table id="r-table"><thead><tr><th>kind</th><th>scope</th><th>started</th><th>status</th><th>rows</th><th>message</th></tr></thead><tbody></tbody></table>

<script>
async function api(url, method='GET', body) {
  const r = await fetch(url, { method, headers: {'content-type':'application/json'}, body: body?JSON.stringify(body):undefined });
  return r.json();
}
async function load() {
  const s = await api('/api/dashboard/stats');
  document.getElementById('c-sess').textContent = s.session ? s.session.c_user : '—';
  document.getElementById('c-groups').textContent = s.counts.groups;
  document.getElementById('c-posts').textContent = s.counts.posts;
  document.getElementById('c-comments').textContent = s.counts.comments;
  document.querySelector('#r-table tbody').innerHTML = s.recent_runs.map(r =>
    \`<tr><td>\${r.kind}</td><td>\${r.scope ?? ''}</td><td>\${new Date(r.started_at).toLocaleString()}</td><td class="\${r.status}">\${r.status}</td><td>\${r.rows_upserted ?? ''}</td><td>\${(r.message ?? '').slice(0,200)}</td></tr>\`
  ).join('');
  const g = await api('/api/groups');
  document.querySelector('#g-table tbody').innerHTML = g.rows.map(r =>
    \`<tr><td>\${r.name ?? '?'}</td><td><code>\${r.group_id}</code></td><td>\${r.privacy ?? ''}</td><td>\${r.member_count ?? ''}</td><td>\${r.enabled}</td>
       <td><button onclick="toggle('\${r.group_id}', \${!r.enabled})">\${r.enabled?'disable':'enable'}</button>
       <button onclick="runGroup('\${r.group_id}')">run now</button></td></tr>\`
  ).join('');
}
async function loadCaps() {
  const r = await api('/api/discover/captures');
  document.querySelector('#d-table tbody').innerHTML = r.rows.map(x =>
    \`<tr><td><code>\${x.friendly_name}</code></td><td>\${x.n}</td><td>\${new Date(x.last_seen).toLocaleString()}</td>
       <td><a href="/api/discover/captures/\${x.sample_id}" target="_blank">view</a></td></tr>\`
  ).join('');
}
async function toggle(id, val) { await fetch('/api/groups/'+id, { method: 'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({enabled: val}) }); load(); }
async function runGroup(id) {
  const r = await api('/api/run', 'POST', { entity: 'fb_group_post', scope: id, mode: 'incr' });
  alert(JSON.stringify(r, null, 2));
  load();
}
load(); loadCaps(); setInterval(load, 15000);
</script>`);
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`server on http://${HOST}:${PORT}`);
});
