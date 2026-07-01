/**
 * Lead DIGEST — a periodic roll-up sent IN ADDITION to the per-lead alerts.
 *
 * Customer ask (Hiếu Trần): instead of only scattered per-lead pings, also get a
 * summary table grouped by account (author): "UserA — 5 leads — 5 groups — links".
 * Daily digest at end of day + weekly digest, in a separate Telegram topic.
 *
 * Triggered by scheduler.ts via POST /api/ops/send-digest {kind}. Iterates every
 * tenant that has Telegram configured + the digest toggle on, builds the roll-up
 * from fact_lead (window) grouped by author, and sends one message per tenant.
 */
import { pool } from '../db.js';

type DigestKind = 'daily' | 'weekly';

const MAX_AUTHORS = 15;        // cap authors listed; rest folded into "+N người khác"
const MAX_LINKS_PER_AUTHOR = 3; // representative links per author; rest → dashboard
const APP_BASE = process.env.APP_PUBLIC_BASE_URL ?? 'https://nextclaw.vn';

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

async function telegramSend(botToken: string, chatId: string, text: string, threadId: number | null): Promise<boolean> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (threadId) body.message_thread_id = threadId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) { console.warn(`[digest] telegram ${res.status}: ${(await res.text()).slice(0, 200)}`); return false; }
    return true;
  } catch (e: any) { console.warn(`[digest] telegram error: ${e?.message ?? e}`); return false; }
  finally { clearTimeout(timer); }
}

interface LeadRow {
  author_id: string | null;
  author_name: string | null;
  group_id: string | null;
  group_name: string | null;
  permalink: string | null;
  message: string | null;
}

interface AuthorBucket {
  name: string;
  leads: LeadRow[];
  groups: Set<string>;
}

/** VN-timezone window for the digest. */
function windowSql(kind: DigestKind): { where: string; label: string } {
  if (kind === 'daily') {
    // Leads detected within the current calendar day in Asia/Ho_Chi_Minh.
    return {
      where: `l.detected_at >= (date_trunc('day', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
      label: 'hôm nay',
    };
  }
  return { where: `l.detected_at >= now() - interval '7 days'`, label: '7 ngày qua' };
}

async function buildTenantDigest(tenantId: string, kind: DigestKind): Promise<string | null> {
  const { where, label } = windowSql(kind);
  const { rows } = await pool.query<LeadRow>(
    `SELECT l.author_id,
            p.raw->'actors'->0->>'name' AS author_name,
            l.group_id,
            g.name AS group_name,
            p.permalink,
            p.message
       FROM fact_lead l
       JOIN fact_group_post p ON p.post_id = l.post_id AND p.tenant_id = l.tenant_id
       LEFT JOIN dim_group g   ON g.group_id = l.group_id AND g.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND ${where}
      ORDER BY l.detected_at DESC`,
    [tenantId],
  );
  if (rows.length === 0) return null; // nothing to report → skip (no empty spam)

  // Group by author. Anonymous (null author_id) folded into one bucket.
  const buckets = new Map<string, AuthorBucket>();
  for (const r of rows) {
    const key = r.author_id ?? '__anon__';
    let b = buckets.get(key);
    if (!b) { b = { name: r.author_name || (r.author_id ? 'Người dùng ' + r.author_id.slice(-6) : 'Ẩn danh'), leads: [], groups: new Set() }; buckets.set(key, b); }
    b.leads.push(r);
    if (r.group_id) b.groups.add(r.group_id);
  }

  const totalLeads = rows.length;
  const totalGroups = new Set(rows.map((r) => r.group_id).filter(Boolean)).size;
  const sorted = [...buckets.values()].sort((a, b) => b.leads.length - a.leads.length);

  const title = kind === 'daily'
    ? `📊 <b>Tổng hợp lead — ${label}</b>`
    : `📊 <b>Tổng hợp lead tuần — ${label}</b>`;
  const lines: string[] = [
    title,
    `Tổng: <b>${totalLeads}</b> lead · <b>${sorted.length}</b> người · <b>${totalGroups}</b> group`,
    '',
  ];

  const shown = sorted.slice(0, MAX_AUTHORS);
  shown.forEach((b, i) => {
    lines.push(`${i + 1}. <b>${escapeHtml(b.name)}</b> — ${b.leads.length} lead · ${b.groups.size} group`);
    for (const lead of b.leads.slice(0, MAX_LINKS_PER_AUTHOR)) {
      const excerpt = (lead.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const grp = escapeHtml(lead.group_name ?? lead.group_id ?? '?');
      const link = lead.permalink ? `<a href="${escapeHtml(lead.permalink)}">${grp}</a>` : grp;
      lines.push(`   • ${link}${excerpt ? ' — <i>' + escapeHtml(excerpt) + '</i>' : ''}`);
    }
    if (b.leads.length > MAX_LINKS_PER_AUTHOR) lines.push(`   … +${b.leads.length - MAX_LINKS_PER_AUTHOR} lead nữa`);
  });

  if (sorted.length > MAX_AUTHORS) lines.push('', `… và <b>${sorted.length - MAX_AUTHORS}</b> người khác`);
  lines.push('', `<a href="${APP_BASE}/#stream">Xem tất cả trên dashboard ↗</a>`);

  return lines.join('\n');
}

/**
 * Build + send the digest to every eligible tenant. Returns per-tenant outcome.
 * Eligible = has telegram_bot_token + chat_id AND the matching digest toggle is
 * not explicitly false (default on).
 */
export async function sendDigests(kind: DigestKind, dryRun = false, onlyTenant?: string): Promise<{ sent: number; skipped: number; tenants: Array<{ tenant_id: string; status: string; preview?: string }> }> {
  const toggle = kind === 'daily' ? 'digest_daily' : 'digest_weekly';
  const params: any[] = [];
  let tenantFilter = '';
  if (onlyTenant) { params.push(onlyTenant); tenantFilter = ` AND tenant_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT tenant_id,
            config->>'telegram_bot_token' AS bot_token,
            config->>'telegram_chat_id'   AS chat_id,
            config->>'telegram_topic_summary' AS topic_summary,
            config->>'${toggle}'          AS toggle
       FROM tenant_settings
      WHERE config->>'telegram_bot_token' IS NOT NULL
        AND config->>'telegram_chat_id'   IS NOT NULL${tenantFilter}`,
    params,
  );

  const out: Array<{ tenant_id: string; status: string; preview?: string }> = [];
  let sent = 0, skipped = 0;
  for (const r of rows) {
    if (r.toggle === 'false') { skipped++; out.push({ tenant_id: r.tenant_id, status: 'toggle_off' }); continue; }
    try {
      const text = await buildTenantDigest(r.tenant_id, kind);
      if (!text) { skipped++; out.push({ tenant_id: r.tenant_id, status: 'no_leads' }); continue; }
      if (dryRun) { out.push({ tenant_id: r.tenant_id, status: 'dry_run', preview: text }); continue; }
      const threadId = r.topic_summary ? Number(r.topic_summary) : null;
      const ok = await telegramSend(r.bot_token, r.chat_id, text, Number.isFinite(threadId as number) ? threadId : null);
      if (ok) { sent++; out.push({ tenant_id: r.tenant_id, status: 'sent' }); }
      else    { skipped++; out.push({ tenant_id: r.tenant_id, status: 'send_failed' }); }
    } catch (e: any) {
      skipped++; out.push({ tenant_id: r.tenant_id, status: `error: ${e?.message ?? e}`.slice(0, 80) });
    }
  }
  return { sent, skipped, tenants: out };
}
