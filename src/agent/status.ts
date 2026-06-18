/**
 * Shared thresholds for agent connection health, used by both the heartbeat
 * route (when responding to agents) and the admin UI (when rendering pills).
 *
 * Status is computed at query time from `agent_connections.last_seen_at` —
 * no separate cron job needed to flip rows to "stale".
 */

export const STATUS_ONLINE_SEC = 180;   // ≤ 3 min: green pill
export const STATUS_STALE_SEC  = 900;   // ≤ 15 min: yellow pill; else offline (red)

export type AgentStatus = 'online' | 'stale' | 'offline';

export function statusOf(lastSeenAt: Date | string | null | undefined, now: Date = new Date()): AgentStatus {
  if (!lastSeenAt) return 'offline';
  const t = typeof lastSeenAt === 'string' ? new Date(lastSeenAt) : lastSeenAt;
  if (Number.isNaN(t.getTime())) return 'offline';
  const ageSec = (now.getTime() - t.getTime()) / 1000;
  if (ageSec <= STATUS_ONLINE_SEC) return 'online';
  if (ageSec <= STATUS_STALE_SEC)  return 'stale';
  return 'offline';
}
