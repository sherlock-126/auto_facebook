/**
 * Execute commands queued by the dashboard.
 *
 * - open_login  / close_login → sudo systemctl (NOPASSWD via /etc/sudoers.d/)
 * - discover_now              → runAll('full') in THIS process (no subprocess)
 *
 * Why in-process for discover_now: a subprocess that does `systemctl stop`
 * on the agent itself ends up killed by systemd (same cgroup). Running in
 * the agent process avoids that — the agent simply blocks its heartbeat loop
 * briefly while crawling (heartbeats still fire from cron timer though).
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';
import { triggerRun, getRunState } from './scheduler.js';
import { fetchOwnerProfile } from './fb/owner_profile.js';
import { postToGroup } from './fb/actions/post_to_group.js';
import { commentOnPost } from './fb/actions/comment_on_post.js';
import type { AgentConfig } from './config.js';

async function reportActionResult(cfg: AgentConfig, body: Record<string, any>): Promise<void> {
  try {
    await fetch(`${cfg.cloud_url}/api/agent/action-result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${cfg.license_key}` },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    log('warn', `action-result report failed: ${e?.message ?? e}`);
  }
}

export type AgentCommand = 'open_login' | 'close_login' | 'discover_now' | 'discover_groups_only' | 'refresh_owner_profile' | 'crawl_now_incr' | 'post_to_group' | 'comment_on_post' | 'reset_profile' | 'repair_browser' | 'restart_agent';

const LOGIN_LOCK = '/var/lib/auto-facebook-agent/login.lock';
const SCRIPTS = '/opt/auto-facebook-agent/scripts';

interface SudoSpec {
  argv: string[];
}

const SUDO_CMDS: Record<string, SudoSpec> = {
  open_login:   { argv: ['sudo', '-n', '/bin/systemctl', 'start', 'auto-facebook-agent-login'] },
  close_login:  { argv: ['sudo', '-n', '/bin/systemctl', 'stop',  'auto-facebook-agent-login'] },
  // Self-serve recovery (dashboard buttons) — each maps to a whitelisted script.
  reset_profile:    { argv: ['sudo', '-n', `${SCRIPTS}/reset-profile.sh`] },
  repair_browser:   { argv: ['sudo', '-n', `${SCRIPTS}/repair-browser.sh`] },
  restart_agent:    { argv: ['sudo', '-n', `${SCRIPTS}/restart-agent.sh`] },
  // On-demand HTTPS tunnel for the embedded noVNC viewer.
  vnc_tunnel_start: { argv: ['sudo', '-n', `${SCRIPTS}/vnc-tunnel.sh`, 'start'] },
  vnc_tunnel_stop:  { argv: ['sudo', '-n', `${SCRIPTS}/vnc-tunnel.sh`, 'stop'] },
};

async function runSudo(spec: SudoSpec): Promise<{ ok: boolean; err?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, err: `exit ${code}: ${stderr.slice(0, 300)}` });
    });
    child.on('error', (e) => resolve({ ok: false, err: e.message }));
  });
}

export async function executeCommand(
  cmd: AgentCommand,
  cfg: AgentConfig,
  payload?: Record<string, any> | null,
): Promise<{ ok: boolean; err?: string }> {
  log('info', `executing dashboard command: ${cmd}${payload?.nav_url ? ` nav_url=${payload.nav_url.slice(0, 80)}` : ''}`);

  if (cmd === 'open_login') {
    // Refuse if a crawl is in-flight — both would launch Chrome on the same
    // persistent profile and the ETL Chrome would crash with
    // "page.evaluate: Target page... closed".
    if (getRunState().in_flight) {
      log('warn', 'open_login REFUSED — crawl in-flight (would corrupt chrome-profile)');
      return { ok: false, err: 'crawl_in_flight' };
    }
    // Write nav URL to a file login.sh reads (default = facebook.com home).
    const navFile = '/var/lib/auto-facebook-agent/login-nav-url';
    try {
      mkdirSync(dirname(navFile), { recursive: true });
      const target = (payload?.nav_url ?? '').trim() || 'https://www.facebook.com/';
      // Basic safety: only allow facebook.com URLs.
      const url = /^https?:\/\/(www\.)?facebook\.com\//.test(target) ? target : 'https://www.facebook.com/';
      writeFileSync(navFile, url);
    } catch (e: any) { log('warn', `failed to write nav url: ${e?.message}`); }
    // Start the login Chrome AND the HTTPS noVNC tunnel concurrently. The tunnel
    // is best-effort: if cloudflared is rate-limited the agent still reports the
    // direct IP URL as a fallback, so login itself never blocks on it.
    const [loginRes, tunnelRes] = await Promise.all([
      runSudo(SUDO_CMDS.open_login),
      runSudo(SUDO_CMDS.vnc_tunnel_start),
    ]);
    if (!tunnelRes.ok) log('warn', `vnc tunnel start failed (falling back to direct URL): ${tunnelRes.err}`);
    return loginRes;
  }

  if (cmd === 'close_login') {
    const r = await runSudo(SUDO_CMDS.close_login);
    void runSudo(SUDO_CMDS.vnc_tunnel_stop); // best-effort cleanup of the tunnel
    return r;
  }

  if (cmd === 'reset_profile' || cmd === 'repair_browser' || cmd === 'restart_agent') {
    // Self-serve recovery — clear the Chrome profile (captcha/login loop), install
    // a real Chrome (snap fix), or restart the agent. Each is a whitelisted script.
    log('info', `${cmd}: running recovery script`);
    const r = await runSudo(SUDO_CMDS[cmd]);
    if (r.ok) log('info', `${cmd}: done`);
    else      log('warn', `${cmd}: failed: ${r.err}`);
    return r;
  }

  if (cmd === 'discover_now') {
    // Route through scheduler.triggerRun so we share the in-process mutex
    // with cron-triggered runs — no double-Chrome-context race.
    const r = await triggerRun(cfg, 'full', 'dashboard');
    if (!r.accepted) {
      log('info', 'discover_now: another run already in flight, skipping');
    }
    return { ok: true };
  }

  if (cmd === 'crawl_now_incr') {
    // Same as cron tick but on-demand — only posts (no comments), all enabled
    // groups. Used by the dashboard "Crawl now" button so the customer doesn't
    // wait up to 15min for the next cron.
    const r = await triggerRun(cfg, 'incr', 'dashboard:crawl_now');
    if (!r.accepted) {
      log('info', 'crawl_now_incr: another run already in flight, skipping');
      return { ok: false, err: 'run_in_flight' };
    }
    return { ok: true };
  }

  if (cmd === 'discover_groups_only') {
    // UX-optimized "Refresh groups list":
    // 1. If the FB login Chrome is open (lock file present), stop the login
    //    service first — its EXIT trap removes login.lock within ~1s.
    // 2. Run the joined-groups discovery entity ONLY (no per-group post crawl)
    //    so customer sees newly-joined groups within ~30-60s of clicking.
    if (existsSync(LOGIN_LOCK)) {
      log('info', 'discover_groups_only: stopping login service to release chrome-profile lock');
      const stopRes = await runSudo({ argv: ['sudo', '-n', '/bin/systemctl', 'stop', 'auto-facebook-agent-login'] });
      if (!stopRes.ok) {
        log('warn', `discover_groups_only: failed to stop login service: ${stopRes.err}`);
        return { ok: false, err: `failed_to_close_login: ${stopRes.err}` };
      }
      // Poll for lock removal (login.sh trap cleans it up on SIGTERM).
      for (let i = 0; i < 20; i++) {
        if (!existsSync(LOGIN_LOCK)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (existsSync(LOGIN_LOCK)) {
        log('warn', 'discover_groups_only: lock still present after 10s, removing stale lock');
        // login.sh creates the lock as auto-fb-agent so this process can rm it directly.
        try { unlinkSync(LOGIN_LOCK); } catch (e: any) { log('warn', `rm lock failed: ${e.message}`); }
      }
    }
    const r = await triggerRun(cfg, 'discover', 'dashboard:refresh_groups');
    if (!r.accepted) {
      log('info', 'discover_groups_only: another run in flight, skipping');
      return { ok: false, err: 'run_in_flight' };
    }
    return { ok: true };
  }

  if (cmd === 'refresh_owner_profile') {
    // Can run in parallel with an in-flight crawl — opens a new page in the
    // same browser context (no chrome-profile contention). Force=true bypasses
    // 7-day cache. Takes ~5-10s.
    log('info', 'refresh_owner_profile: fetching from facebook.com/me');
    const p = await fetchOwnerProfile(true);
    if (!p) return { ok: false, err: 'fetch_failed' };
    log('info', `refresh_owner_profile done: name=${p.name?.slice(0, 40)}`);
    return { ok: true };
  }

  if (cmd === 'post_to_group') {
    // payload = { action_id, group_url, content, image_urls?: string[] }
    const action_id = payload && (payload as any).action_id;
    const group_url = payload && (payload as any).group_url;
    const content   = payload && (payload as any).content;
    const image_urls = (payload && (payload as any).image_urls) || [];
    if (!action_id || !group_url || !content) {
      return { ok: false, err: 'missing_payload' };
    }
    // Refuse if a crawl is in-flight — chrome-profile lock collision.
    if (getRunState().in_flight) {
      log('info', `post_to_group(${action_id}): crawl in-flight, deferring`);
      return { ok: false, err: 'crawl_in_flight' };
    }
    log('info', `post_to_group(${action_id}): start group=${group_url}`);
    const r = await postToGroup({ group_url, content, image_urls });
    log('info', `post_to_group(${action_id}): ${r.status} in ${r.duration_ms}ms ${r.error ?? ''}`);
    void reportActionResult(cfg, {
      action_type: 'post', action_id,
      status: r.status, error: r.error ?? null,
    });
    return { ok: r.status === 'posted' || r.status === 'pending_review', err: r.error };
  }

  if (cmd === 'comment_on_post') {
    // payload = { action_id, post_url, content }
    const action_id = payload && (payload as any).action_id;
    const post_url  = payload && (payload as any).post_url;
    const content   = payload && (payload as any).content;
    if (!action_id || !post_url || !content) {
      return { ok: false, err: 'missing_payload' };
    }
    if (getRunState().in_flight) {
      log('info', `comment_on_post(${action_id}): crawl in-flight, deferring`);
      return { ok: false, err: 'crawl_in_flight' };
    }
    log('info', `comment_on_post(${action_id}): start post=${post_url.slice(0,80)}`);
    const r = await commentOnPost({ post_url, content });
    log('info', `comment_on_post(${action_id}): ${r.status} in ${r.duration_ms}ms ${r.error ?? ''}`);
    void reportActionResult(cfg, {
      action_type: 'reply', action_id,
      status: r.status, error: r.error ?? null,
    });
    return { ok: r.status === 'commented' || r.status === 'submitted', err: r.error };
  }

  return { ok: false, err: 'unknown command' };
}
