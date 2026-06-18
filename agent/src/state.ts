/**
 * Local watermark storage for the agent. Replaces cloud's `etl_watermark` table.
 * Stored as JSON at /var/lib/auto-facebook-agent/state.json. Atomic write via
 * tmp+rename so a crash mid-write can't corrupt the file.
 *
 * Schema:
 *   {
 *     "watermarks": {
 *       "<entity>:<scope>": {
 *         "last_cursor_time": "2026-05-20T07:00:00.000Z",
 *         "last_run_at":      "2026-05-20T07:00:01.000Z",
 *         "last_run_status":  "ok" | "error",
 *         "last_run_count":   123,
 *         "last_error":       null | "..."
 *       }
 *     }
 *   }
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_STATE_PATH = process.env.AGENT_STATE_PATH || '/var/lib/auto-facebook-agent/state.json';

interface WatermarkRow {
  last_cursor_time: string | null;
  last_run_at:      string;
  last_run_status:  'ok' | 'error';
  last_run_count:   number;
  last_error:       string | null;
}

interface StateFile {
  watermarks: Record<string, WatermarkRow>;
}

function emptyState(): StateFile { return { watermarks: {} }; }

function loadFile(path: string): StateFile {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.watermarks) return emptyState();
    return parsed as StateFile;
  } catch {
    return emptyState();
  }
}

function saveFile(path: string, state: StateFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, path);
}

function keyOf(entity: string, scope: string): string { return `${entity}:${scope}`; }

export function readWatermark(entity: string, scope: string, path = DEFAULT_STATE_PATH): Date | null {
  const state = loadFile(path);
  const row = state.watermarks[keyOf(entity, scope)];
  if (!row?.last_cursor_time) return null;
  const d = new Date(row.last_cursor_time);
  return isNaN(d.getTime()) ? null : d;
}

export interface WriteWatermarkArgs {
  entity: string;
  scope:  string;
  cursor: Date;
  status: 'ok' | 'error';
  count:  number;
  error?: string;
}

export function writeWatermark(args: WriteWatermarkArgs, path = DEFAULT_STATE_PATH): void {
  const state = loadFile(path);
  const key = keyOf(args.entity, args.scope);
  const existing = state.watermarks[key];
  // Never go backward (mirror cloud's GREATEST() in writeWatermark).
  const newCursor =
    existing?.last_cursor_time && new Date(existing.last_cursor_time).getTime() > args.cursor.getTime()
      ? existing.last_cursor_time
      : args.cursor.toISOString();
  state.watermarks[key] = {
    last_cursor_time: newCursor,
    last_run_at:      new Date().toISOString(),
    last_run_status:  args.status,
    last_run_count:   args.count,
    last_error:       args.error ?? null,
  };
  saveFile(path, state);
}

/** Snapshot of ALL watermarks — included in heartbeat so cloud DB stays in
 * sync. Compact form (`entity:scope` key flattened). */
export interface WatermarkSnapshot {
  entity:           string;
  scope:            string;
  last_cursor_time: string | null;
  last_run_at:      string;
  last_run_status:  string;
  last_run_count:   number;
}
export function getAllWatermarks(path = DEFAULT_STATE_PATH): WatermarkSnapshot[] {
  const state = loadFile(path);
  return Object.entries(state.watermarks).map(([k, v]) => {
    const idx = k.indexOf(':');
    return {
      entity:           idx > 0 ? k.slice(0, idx) : k,
      scope:            idx > 0 ? k.slice(idx + 1) : '',
      last_cursor_time: v.last_cursor_time,
      last_run_at:      v.last_run_at,
      last_run_status:  v.last_run_status,
      last_run_count:   v.last_run_count,
    };
  });
}

/** Bootstrap: apply cloud-authoritative watermarks to local state on agent
 * startup. Uses GREATEST semantics — only advances local cursor if cloud is
 * newer. Survives backup-restore of agent VPS (local state.json reverts to
 * old, but cloud kept advancing via prior heartbeats → boot syncs back). */
export function mergeRemoteWatermarks(
  remote: Array<{ entity: string; scope: string; last_cursor_time: string | null }>,
  path = DEFAULT_STATE_PATH,
): number {
  let applied = 0;
  for (const r of remote) {
    if (!r.last_cursor_time) continue;
    const d = new Date(r.last_cursor_time);
    if (isNaN(d.getTime())) continue;
    const localBefore = readWatermark(r.entity, r.scope, path);
    if (!localBefore || d.getTime() > localBefore.getTime()) {
      writeWatermark({
        entity: r.entity, scope: r.scope, cursor: d,
        status: 'ok', count: 0,
      }, path);
      applied++;
    }
  }
  return applied;
}
