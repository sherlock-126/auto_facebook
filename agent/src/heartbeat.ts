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
import { existsSync, readFileSync } from 'node:fs';
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
  command?:         'open_login' | 'close_login' | 'discover_now' | 'discover_groups_only' | 'refresh_owner_profile' | 'crawl_now_incr' | 'post_to_group' | 'comment_on_post' | 'reset_profile' | 'repair_browser' | 'restart_agent' | null;
  command_payload?: { nav_url?: string } | null;
  config?:          { heartbeat_interval_sec?: number };
}

const TUNNEL_URL_FILE = '/var/lib/auto-facebook-agent/vnc-tunnel-url';

/**
 * The viewer URL the dashboard should use. Prefer the on-demand Cloudflare tunnel
 * (HTTPS → embeddable in the dashboard iframe, works behind NAT). Fall back to the
 * direct http://<ip>:<port> URL (only usable via "open in new tab" on a public-IP
 * VPS). Returns null when neither is available.
 */
function readVncUrl(cfg: AgentConfig): string | null {
  // 1. Tunnel file (written by vnc-tunnel.sh while a login session is open).
  try {
    if (existsSync(TUNNEL_URL_FILE)) {
      const base = readFileSync(TUNNEL_URL_FILE, 'utf8').trim().replace(/\/+$/, '');
      if (/^https:\/\//.test(base) && cfg.vnc_password) {
        return `${base}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(cfg.vnc_password)}`;
      }
    }
  } catch { /* fall through to direct URL */ }
  // 2. Direct IP fallback.
  if (!cachedIp) cachedIp = detectPublicIp();
  if (cachedIp && cfg.vnc_password) {
    return `http://${cachedIp}:${cfg.vnc_port}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(cfg.vnc_password)}`;
  }
  return null;
}

/** Browser binary health — surfaced in the dashboard diagnostics card. Best-effort. */
function detectBrowser(): { type: 'snap' | 'deb' | 'missing'; ok: boolean; path: string | null } {
  try {
    const p = process.env.CHROME_PATH || null;
    if (!p || !existsSync(p)) return { type: 'missing', ok: false, path: p };
    return { type: p.startsWith('/snap/') ? 'snap' : 'deb', ok: true, path: p };
  } catch { return { type: 'missing', ok: false, path: null }; }
}

/**
 * os.networkInterfaces() can throw a libuv system error — observed in the wild as
 * EAFNOSUPPORT(97) "uv_interface_addresses returned Unknown system error 97" when
 * an interface is flapping (e.g. a TUN device like tailscale0, or docker0 going
 * up/down). It is NEVER worth killing the heartbeat over a diagnostic, so swallow.
 */
function safeNICs(): ReturnType<typeof os.networkInterfaces> {
  try { return os.networkInterfaces(); } catch { return {}; }
}

/** First non-internal IPv4 — shown as a diagnostic / fallback access hint. Best-effort. */
function detectLanIp(): string | null {
  for (const addrs of Object.values(safeNICs())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address;
    }
  }
  return null;
}

/** Tailscale CGNAT IP (100.64.0.0/10) if the agent is on a tailnet. Best-effort. */
function detectTailscaleIp(): string | null {
  for (const [name, addrs] of Object.entries(safeNICs())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (name.startsWith('tailscale') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) return a.address;
    }
  }
  return null;
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
  const vncUrl = readVncUrl(cfg);
  const browser = detectBrowser();

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
    // Diagnostics for the dashboard health card (snap detection, NAT hints).
    chrome_type:      browser.type,
    chrome_ok:        browser.ok,
    lan_ip:           detectLanIp(),
    tailscale_ip:     detectTailscaleIp(),
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
