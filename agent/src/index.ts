/**
 * fb.autonow.vn agent — entry point (Phase B v0.2).
 *
 * Boot sequence:
 *   1. Load /etc/auto-facebook-agent/config.json
 *   2. Start heartbeat loop (60s default)
 *   3. Start cron scheduler — crawls every 2h, full sweep nightly at 3am
 *      Initial incr crawl fires 30s after boot
 *
 * Exit codes:
 *   1 = unrecoverable (bad config, 401 from cloud)
 *   0 = clean shutdown via SIGTERM/SIGINT
 */
import { loadConfig } from './config.js';
import { sendHeartbeat, AuthFailedError } from './heartbeat.js';
import { startScheduler } from './scheduler.js';
import { closeBrowserContext } from './fb/browser.js';
import { executeCommand, type AgentCommand } from './commands.js';
import { AGENT_VERSION } from './version.js';
import { notifyReady, notifyWatchdog } from './watchdog.js';
import { mergeRemoteWatermarks } from './state.js';
import { log } from './log.js';

async function bootstrapWatermarks(cfg: { cloud_url: string; license_key: string }): Promise<void> {
  // Pull cloud-authoritative watermarks once on startup. If local state.json
  // got reverted (backup-restore) or is empty (fresh install), this restores
  // the latest cursor known to cloud — preventing re-crawl of stale backlog
  // that would timeout each sweep.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${cfg.cloud_url}/api/agent/watermarks`, {
      headers: { 'authorization': `Bearer ${cfg.license_key}` },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) { log('warn', `watermark bootstrap: HTTP ${res.status}`); return; }
    const j = (await res.json()) as { watermarks?: Array<any> };
    const remote = Array.isArray(j?.watermarks) ? j.watermarks : [];
    const applied = mergeRemoteWatermarks(remote);
    log('info', `watermark bootstrap: ${remote.length} from cloud, ${applied} applied (newer than local)`);
  } catch (e: any) {
    // Non-fatal — agent falls back to local state.json
    log('warn', `watermark bootstrap failed: ${e?.message ?? e}`);
  }
}

let stopping = false;
let nextHeartbeat: NodeJS.Timeout | null = null;

async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', `shutdown requested (${sig})`);
  if (nextHeartbeat) clearTimeout(nextHeartbeat);
  try { await closeBrowserContext(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e: any) {
    log('fatal', e.message);
    process.exit(1);
  }
  log('info', 'agent starting', {
    version: AGENT_VERSION, cloud_url: cfg.cloud_url, vnc_port: cfg.vnc_port,
  });

  // Tell systemd we're alive ASAP, before the (potentially slow) first
  // heartbeat. Otherwise Type=notify times out (default 90s).
  notifyReady();

  // Pull cloud watermarks → reseed local state.json (survives backup-restore).
  // Best-effort; non-blocking failures fall back to local state.
  await bootstrapWatermarks(cfg);

  // Heartbeat loop — adaptive interval if server sends one in response.
  // If response includes a `command`, execute it (open_login / close_login /
  // discover_now). Report back as last_command on next heartbeat.
  let intervalSec = 60;
  let lastCommand: string | undefined;
  let lastCommandAt: string | undefined;
  async function heartbeatTick(): Promise<void> {
    if (stopping) return;
    try {
      const res = await sendHeartbeat(cfg!, { last_command: lastCommand, last_command_at: lastCommandAt });
      const cfgInterval = Number(res?.config?.heartbeat_interval_sec);
      if (Number.isFinite(cfgInterval) && cfgInterval >= 10 && cfgInterval <= 600) {
        intervalSec = cfgInterval;
      }
      // Heartbeat reached cloud → also kick the systemd watchdog. If the event
      // loop blocks (Playwright hang etc.), both heartbeat AND watchdog stop →
      // systemd kills + restarts the agent within WatchdogSec.
      notifyWatchdog();
      log('info', 'heartbeat ok', { server_time: res?.server_time, next_in_sec: intervalSec, command: res?.command ?? null });

      // Execute dashboard command (out-of-band, doesn't block heartbeat).
      if (res?.command) {
        const cmd = res.command as AgentCommand;
        const payload = (res as any).command_payload ?? null;
        void executeCommand(cmd, cfg!, payload).then((r) => {
          lastCommand = cmd;
          lastCommandAt = new Date().toISOString();
          if (r.ok) log('info', `command ${cmd} done`);
          else      log('warn', `command ${cmd} failed: ${r.err}`);
        });
      }
    } catch (e: any) {
      if (e instanceof AuthFailedError) {
        log('fatal', e.message);
        process.exit(1);
      }
      log('warn', `heartbeat failed: ${e?.message ?? e}`);
    }
    if (!stopping) nextHeartbeat = setTimeout(heartbeatTick, intervalSec * 1000);
  }
  await heartbeatTick();

  // ETL scheduler
  startScheduler(cfg);

  log('info', 'agent ready');
}

main().catch((e) => {
  log('fatal', `unhandled: ${e?.message ?? String(e)}`);
  process.exit(1);
});
