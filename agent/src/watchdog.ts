/**
 * systemd watchdog integration.
 *
 * When the unit has Type=notify + WatchdogSec=N, systemd kills + restarts the
 * service if it doesn't receive a WATCHDOG=1 ping within N seconds. We piggy-
 * back on the heartbeat loop: each successful heartbeat also pings the
 * watchdog. If the Node event loop blocks (e.g. Playwright page.evaluate hangs
 * forever) → heartbeats stop → watchdog stops → systemd kicks the agent.
 *
 * Implementation: shell out to `systemd-notify`. Node has no native AF_UNIX
 * datagram support, and overhead is negligible (one fork per 60s).
 */
import { execFileSync } from 'node:child_process';
import { log } from './log.js';

const HAS_NOTIFY_SOCKET = !!process.env.NOTIFY_SOCKET;

export function notifyReady(): void {
  if (!HAS_NOTIFY_SOCKET) return;
  try {
    execFileSync('systemd-notify', ['--ready'], { stdio: 'ignore' });
  } catch (e: any) {
    log('warn', `systemd-notify READY failed: ${e?.message ?? e}`);
  }
}

export function notifyWatchdog(): void {
  if (!HAS_NOTIFY_SOCKET) return;
  try {
    execFileSync('systemd-notify', ['WATCHDOG=1'], { stdio: 'ignore' });
  } catch (e: any) {
    // Don't log every miss — if systemd is gone, every 60s would spam.
  }
}
