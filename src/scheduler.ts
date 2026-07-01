/**
 * Cron-only daemon. Fires HTTP POST /api/run/all on the local Fastify server
 * on a schedule. The server owns the Chrome persistent profile and serializes
 * runs via a PG advisory lock, so this process is intentionally trivial.
 */
import 'dotenv/config';
import cron from 'node-cron';

const HOST = process.env.APP_HOST_INTERNAL ?? '127.0.0.1';
const PORT = Number(process.env.APP_PORT ?? 4200);
const BASE = `http://${HOST}:${PORT}`;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
if (!INTERNAL_TOKEN) console.warn('scheduler: INTERNAL_API_TOKEN is empty — requests will 401');
// No HTTP timeout — runAll can legitimately take 30+ min for a full sweep.

async function trigger(mode: 'incr' | 'full', label: string) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE}/api/run/all`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ mode }),
    });
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    const body = await res.text();
    console.log(`[${label}] ${res.status} in ${took}s — ${body.slice(0, 300)}`);
  } catch (e: any) {
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`[${label}] failed after ${took}s: ${e?.message ?? e}`);
  }
}

const INCR = process.env.CRON_INCR ?? '*/30 * * * *';
const FULL = process.env.CRON_FULL ?? '0 3 * * *';
const OPS_HEALTH = process.env.CRON_OPS_HEALTH ?? '*/5 * * * *';

// Cloud-only mode (prod cloud on nextclaw.vn): scraping runs on customer agents,
// not here — so skip the local crawl triggers and keep only the ops-health monitor.
const CLOUD_ONLY = process.env.CLOUD_ONLY === '1';
if (!CLOUD_ONLY) {
  cron.schedule(INCR, () => void trigger('incr', 'incr'));
  cron.schedule(FULL, () => void trigger('full', 'full'));
} else {
  console.log('scheduler: CLOUD_ONLY=1 — skipping local crawl triggers (agents scrape on their own VPS)');
}

// Ops health: POST /api/ops/check-agent-health → Telegram alerts on transitions.
async function triggerHealthCheck() {
  try {
    const res = await fetch(`${BASE}/api/ops/check-agent-health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    if (!res.ok) console.warn(`[ops-health] ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e: any) { console.warn(`[ops-health] failed: ${e?.message ?? e}`); }
}
cron.schedule(OPS_HEALTH, () => void triggerHealthCheck());

// Lead digest — daily end-of-day + weekly roll-up grouped by author, sent in
// addition to per-lead alerts. Times are UTC; defaults = 21:00 VN daily and
// 21:00 VN Sunday (VN = UTC+7 → 14:00 UTC).
const DIGEST_DAILY  = process.env.CRON_DIGEST_DAILY  ?? '0 14 * * *';
const DIGEST_WEEKLY = process.env.CRON_DIGEST_WEEKLY ?? '0 14 * * 0';
async function triggerDigest(kind: 'daily' | 'weekly') {
  try {
    const res = await fetch(`${BASE}/api/ops/send-digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: JSON.stringify({ kind }),
    });
    console.log(`[digest:${kind}] ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e: any) { console.warn(`[digest:${kind}] failed: ${e?.message ?? e}`); }
}
cron.schedule(DIGEST_DAILY,  () => void triggerDigest('daily'));
cron.schedule(DIGEST_WEEKLY, () => void triggerDigest('weekly'));

console.log(`scheduler running (HTTP trigger -> ${BASE}/api/run/all): incr="${INCR}", full="${FULL}", ops-health="${OPS_HEALTH}", digest-daily="${DIGEST_DAILY}", digest-weekly="${DIGEST_WEEKLY}"`);

let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`scheduler shutting down (${sig})`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
