/**
 * Single heartbeat POST to {cloud_url}/api/agent/heartbeat.
 *
 * In v0.3+: also report current login_active / fb_session_alive / vnc_public_url
 * so cloud dashboard can show pills + render the "Open Facebook" link. The
 * response may include a `command` (open_login | close_login | discover_now)
 * the agent must execute.
 */
import os from 'node:os';
import { execSync } from 'node:child_process';
import { AGENT_VERSION } from './version.js';
import { profileLooksLoggedIn } from './fb/session.js';
import { getRunState } from './scheduler.js';
import { readCachedOwnerProfile } from './fb/owner_profile.js';
import { getAllWatermarks } from './state.js';
import type { AgentConfig } from './config.js';

export class AuthFailedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'AuthFailedError'; }
}

export interface HeartbeatResponse {
  ok:           boolean;
  server_time?: string;
  command?:         'open_login' | 'close_login' | 'discover_now' | 'discover_groups_only' | 'refresh_owner_profile' | null;
  command_payload?: { nav_url?: string } | null;
  config?:          { heartbeat_interval_sec?: number };
}

function isUnitActive(unit: string): boolean {
  try {
    execSync(`systemctl is-active --quiet ${unit}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function detectPublicIp(): string | null {
  // Best-effort: try ip metadata, fall back to hostname.
  try {
    return execSync('curl -fs -m 3 https://api.ipify.org || echo ""', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch { return null; }
}

function readRootDisk(): { used_pct: number | null; avail_gb: number | null } {
  // Parse `df / -B1 --output=pcent,avail` — second line has "<pct>% <bytes>".
  // No GNU coreutils gymnastics; df is universally available.
  try {
    const out = execSync('df / -B1 --output=pcent,avail', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const line = out.split('\n')[1]?.trim() ?? '';
    const m = line.match(/(\d+)%\s+(\d+)/);
    if (!m) return { used_pct: null, avail_gb: null };
    return { used_pct: Number(m[1]), avail_gb: Math.round((Number(m[2]) / 1_073_741_824) * 10) / 10 };
  } catch { return { used_pct: null, avail_gb: null }; }
}

let cachedIp: string | null = null;

export async function sendHeartbeat(
  cfg: AgentConfig,
  state: { last_command?: string; last_command_at?: string } = {},
): Promise<HeartbeatResponse> {
  if (!cachedIp) cachedIp = detectPublicIp();
  const vncUrl = cachedIp && cfg.vnc_password
    ? `http://${cachedIp}:${cfg.vnc_port}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(cfg.vnc_password)}`
    : null;

  const runState = getRunState();
  const owner = readCachedOwnerProfile();
  const disk = readRootDisk();
  const payload = {
    agent_version:    AGENT_VERSION,
    hostname:         os.hostname(),
    os:               `${os.platform()} ${os.release()}`,
    ram_mb:           Math.round(os.totalmem() / 1024 / 1024),
    uptime_s:         Math.round(process.uptime()),
    system_uptime_s:  Math.round(os.uptime()),
    login_active:     isUnitActive('auto-facebook-agent-login'),
    fb_session_alive: profileLooksLoggedIn(),
    vnc_public_url:   vncUrl,
    last_command:     state.last_command ?? null,
    last_command_at:  state.last_command_at ?? null,
    run_in_flight:    runState.in_flight,
    run_started_at:   runState.started_at,
    run_mode:         runState.mode,
    run_label:        runState.label,
    run_groups_done:  runState.groups_done,
    run_groups_total: runState.groups_total,
    run_current_group: runState.current_group,
    owner_name:       owner?.name ?? null,
    owner_avatar_url: owner?.avatar_url ?? null,
    disk_used_pct:    disk.used_pct,
    disk_avail_gb:    disk.avail_gb,
    // Mirror local watermark state to cloud — survives backup-restore.
    watermarks:       getAllWatermarks(),
  };

  const url = `${cfg.cloud_url}/api/agent/heartbeat`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${cfg.license_key}`,
        'user-agent':    `auto-facebook-agent/${AGENT_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }

  if (res.status === 401) {
    const body = await res.text().catch(() => '');
    throw new AuthFailedError(`heartbeat 401: ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`heartbeat ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json().catch(() => ({}))) as HeartbeatResponse;
}
