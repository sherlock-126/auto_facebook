/**
 * Agent's cron scheduler. Direct in-process call to runAll() (no HTTP loopback
 * like the cloud's scheduler.ts — the agent IS the worker).
 *
 * Serialization: a single in-memory `inFlight` promise prevents overlapping
 * runs if cron fires while a previous run is still going.
 */
import cron from 'node-cron';
import { runAll, runDiscoverOnly } from './runner.js';
import { log } from './log.js';
import type { AgentConfig } from './config.js';

const CRON_INCR = process.env.AGENT_CRON_INCR ?? '*/15 * * * *'; // every 15min (posts only → leads within ~15min)
const CRON_FULL = process.env.AGENT_CRON_FULL ?? '0 3 * * *';    // 03:00 daily (posts + comments + discovery)

let inFlight: Promise<unknown> | null = null;
let startedAt: Date | null = null;
let currentMode: 'incr' | 'full' | 'discover' | null = null;
let currentLabel: string | null = null;
let groupsDone = 0;
let groupsTotal = 0;
let currentGroup: string | null = null;

/** Snapshot of current run state — included in every heartbeat. */
export function getRunState(): {
  in_flight: boolean; started_at: string | null;
  mode: string | null; label: string | null;
  groups_done: number; groups_total: number; current_group: string | null;
} {
  return {
    in_flight:    inFlight !== null,
    started_at:   startedAt ? startedAt.toISOString() : null,
    mode:         currentMode,
    label:        currentLabel,
    groups_done:  groupsDone,
    groups_total: groupsTotal,
    current_group: currentGroup,
  };
}

/** Called by runner.ts to report progress mid-run. */
export function setRunProgress(done: number, total: number, group: string | null): void {
  groupsDone = done;
  groupsTotal = total;
  currentGroup = group;
}

export async function triggerRun(cfg: AgentConfig, mode: 'incr' | 'full' | 'discover', label: string): Promise<{ accepted: boolean }> {
  if (inFlight) {
    log('warn', `runAll(${mode}) skipped — previous run still in flight since ${startedAt?.toISOString()}`);
    return { accepted: false };
  }
  startedAt    = new Date();
  currentMode  = mode;
  currentLabel = label;
  inFlight = (async () => {
    try {
      const r = mode === 'discover' ? await runDiscoverOnly(cfg) : await runAll(cfg, mode);
      log('info', `runAll(${mode}) finished`, {
        label, ok: r.ok, results: r.results.length, errors: r.errors.length,
      });
    } catch (e: any) {
      log('error', `runAll(${mode}) failed`, { label, err: e?.message });
    } finally {
      inFlight = null;
      startedAt = null;
      currentMode = null;
      currentLabel = null;
      groupsDone = 0;
      groupsTotal = 0;
      currentGroup = null;
    }
  })();
  inFlight.catch(() => {});
  return { accepted: true };
}

export function startScheduler(cfg: AgentConfig): void {
  cron.schedule(CRON_INCR, () => void triggerRun(cfg, 'incr', 'cron'));
  cron.schedule(CRON_FULL, () => void triggerRun(cfg, 'full', 'cron'));
  log('info', `scheduler armed`, { incr: CRON_INCR, full: CRON_FULL });

  // Trigger an initial incremental run shortly after boot so customer sees data
  // flowing within minutes of install (otherwise they'd wait until next 0 */2).
  if (process.env.AGENT_SKIP_INITIAL_RUN !== 'true') {
    setTimeout(() => triggerRun(cfg, 'incr', 'initial'), 30_000);
  }
}
