/**
 * Agent health monitoring + Telegram transition alerts.
 *
 * Runs periodically (every ~5 min, triggered by scheduler.ts via the internal
 * /api/ops/check-agent-health endpoint). For each tenant that has a Telegram
 * bot configured, looks at the agent's last heartbeat:
 *
 *   - `online`  (≤ 3 min):   green — pipeline healthy
 *   - `stale`   (≤ 15 min):  yellow — heartbeat slightly late, might recover
 *   - `offline` (> 15 min):  red — agent/VM is down, pipeline frozen
 *
 * Telegram only fires on a TRANSITION (online ↔ offline, etc.) so a long
 * outage produces 1 alert, not one every 5 min. Last-reported status is
 * persisted on the row (agent_connections.last_status*) so the de-dup
 * survives a cloud restart.
 *
 * Also surfaces disk-full warnings when the agent reports disk_used_pct
 * crossing 85%.
 */
import { pool } from '../db.js';
import { STATUS_STALE_SEC, STATUS_ONLINE_SEC, statusOf, type AgentStatus } from '../agent/status.js';

const DISK_ALERT_PCT = Number(process.env.AGENT_DISK_ALERT_PCT ?? 85);

interface TenantRow {
  tenant_id:        string;
  last_seen_at:     Date | null;
  last_status:      string | null;
  last_status_at:   Date | null;
  disk_used_pct:    number | null;
  fb_session_alive: boolean | null;
  health_state:     Record<string, string> | null;
  bot_token:        string | null;
  chat_id:          string | null;
}

async function telegramSend(botToken: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ops-alert] telegram send failed: ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.warn(`[ops-alert] telegram send error: ${e?.message ?? e}`);
  } finally { clearTimeout(timer); }
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60)        return `${s}s`;
  if (s < 3600)      return `${Math.round(s / 60)} phút`;
  if (s < 86400)     return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return `${d} ngày ${h}h`;
}

function statusEmoji(s: AgentStatus): string {
  return s === 'online' ? '✅' : s === 'stale' ? '🟡' : '🚨';
}

export async function checkAgentHealth(): Promise<{ checked: number; alerts: number }> {
  const { rows } = await pool.query<TenantRow>(
    `SELECT ac.tenant_id, ac.last_seen_at, ac.last_status, ac.last_status_at,
            ac.disk_used_pct, ac.fb_session_alive, ac.health_state,
            ts.config->>'telegram_bot_token' AS bot_token,
            ts.config->>'telegram_chat_id'   AS chat_id
       FROM agent_connections ac
       JOIN tenant_settings   ts USING (tenant_id)
      WHERE ts.config->>'telegram_bot_token' IS NOT NULL
        AND ts.config->>'telegram_chat_id'   IS NOT NULL`,
  );

  let alerts = 0;
  const now = new Date();

  for (const r of rows) {
    if (!r.bot_token || !r.chat_id) continue;

    const currentStatus = statusOf(r.last_seen_at, now);
    // First observation: baseline = current status (no alert; just record). This
    // prevents a re-alert spam when the cloud restarts mid-outage.
    const isFirstObservation = r.last_status === null;
    const prevStatus = isFirstObservation
      ? currentStatus
      : (r.last_status as AgentStatus);

    if (isFirstObservation) {
      await pool.query(
        `UPDATE agent_connections SET last_status = $1, last_status_at = $2 WHERE tenant_id = $3`,
        [currentStatus, now, r.tenant_id],
      );
    }

    // Status transition (online ↔ stale/offline). Skip stale ↔ stale, online ↔ online.
    if (currentStatus !== prevStatus) {
      const ageSec = r.last_seen_at
        ? (now.getTime() - new Date(r.last_seen_at).getTime()) / 1000
        : Infinity;

      let msg: string;
      if (currentStatus === 'offline') {
        msg = `${statusEmoji(currentStatus)} <b>Agent OFFLINE</b> — heartbeat cuối ${fmtDuration(ageSec)} trước.\n`
            + `Pipeline lead đang DỪNG. Check VPS (caycuoc) ngay.`;
      } else if (currentStatus === 'stale') {
        msg = `${statusEmoji(currentStatus)} <b>Agent STALE</b> — heartbeat trễ ${fmtDuration(ageSec)}. Theo dõi 5-10 phút nữa, nếu chuyển OFFLINE thì cần can thiệp.`;
      } else {
        // recovered → online
        const downSec = r.last_status_at
          ? (now.getTime() - new Date(r.last_status_at).getTime()) / 1000
          : 0;
        msg = `${statusEmoji(currentStatus)} <b>Agent ONLINE lại</b> sau ${fmtDuration(downSec)} (trạng thái trước: ${prevStatus}). Pipeline lead chạy lại.`;
      }

      await telegramSend(r.bot_token, r.chat_id, msg);
      alerts++;

      await pool.query(
        `UPDATE agent_connections SET last_status = $1, last_status_at = $2 WHERE tenant_id = $3`,
        [currentStatus, now, r.tenant_id],
      );
    }

    // ─── Stuck detectors — only run when agent is actually online (otherwise
    //     the OFFLINE alert already covers it; running these too would spam).
    if (currentStatus === 'online') {
      const healthState = r.health_state ?? {};

      // 1. FB session dead — needs noVNC re-login. Fires once on transition
      //    healthy → dead, again on dead → healthy.
      {
        const cur = r.fb_session_alive === false ? 'dead' : 'healthy';
        const prev = healthState.session ?? 'healthy';
        if (cur !== prev) {
          const msg = cur === 'dead'
            ? `💀 <b>FB session đã hết</b> — agent chạy nhưng không crawl được. Login lại qua noVNC: Setup → Kết nối → "Mở Facebook".`
            : `✅ <b>FB session OK lại</b>. Pipeline crawl bình thường.`;
          await telegramSend(r.bot_token, r.chat_id, msg);
          alerts++;
          healthState.session = cur;
        }
      }

      // 2. Disk usage transition (healthy ↔ full) — based on threshold.
      {
        const diskNow = typeof r.disk_used_pct === 'number' ? r.disk_used_pct : null;
        const cur = (diskNow !== null && diskNow >= DISK_ALERT_PCT) ? 'full' : 'healthy';
        const prev = healthState.disk ?? 'healthy';
        if (cur !== prev) {
          const msg = cur === 'full'
            ? `💽 <b>Disk caycuoc đầy ${diskNow}%</b> — sắp hết chỗ. SSH dọn cache: <code>systemctl stop auto-facebook-agent && rm -rf /var/lib/auto-facebook-agent/chrome-profile && systemctl start auto-facebook-agent</code> (sẽ cần re-login FB qua noVNC).`
            : `✅ <b>Disk caycuoc OK lại</b> (${diskNow}%).`;
          await telegramSend(r.bot_token, r.chat_id, msg);
          alerts++;
          healthState.disk = cur;
        }
      }

      // Persist health_state once (cover both checks above).
      await pool.query(
        `UPDATE agent_connections SET health_state = $1::jsonb WHERE tenant_id = $2`,
        [JSON.stringify(healthState), r.tenant_id],
      );
    }
  }

  return { checked: rows.length, alerts };
}
