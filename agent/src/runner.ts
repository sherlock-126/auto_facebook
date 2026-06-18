/**
 * Agent's ETL runner — port of cloud's src/etl/runner.ts.
 *
 * Differences:
 *   - listEnabledGroups → HTTP call to /api/agent/groups-to-crawl
 *   - logRunStart/Finish → uploadBatch('run', ...) so cloud shows run history
 *     under the agent's tenant_id in etl_run
 */
import { createFbClient, SessionWallError } from './fb/client.js';
import { BudgetExceededError } from './fb/budget.js';
import { profileLooksLoggedIn } from './fb/session.js';
import { closeBrowserContext } from './fb/browser.js';
import { ENTITIES, type EntityRunResult } from './etl/entity_registry.js';
import { fetchGroupsToCrawl, uploadBatch } from './upload.js';
import { log } from './log.js';
import { setRunProgress } from './scheduler.js';
import { fetchOwnerProfile } from './fb/owner_profile.js';
import type { AgentConfig } from './config.js';
import { existsSync } from 'node:fs';

const LOGIN_LOCK = '/var/lib/auto-facebook-agent/login.lock';

// Hard timeout per (entity, group). Defends against Chrome/Playwright hangs
// where the underlying page.evaluate() never returns. Without this, the whole
// agent process blocks indefinitely — heartbeats stop, watchdog kicks in, but
// we lose a full sweep cycle. With this, we skip the stuck group and proceed.
const ENTITY_TIMEOUT_MS = Number(process.env.AGENT_ENTITY_TIMEOUT_MS ?? 180_000);

class EntityTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`entity timeout >${ms}ms: ${label}`);
    this.name = 'EntityTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EntityTimeoutError(label, ms)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface RunSummary {
  ok:      boolean;
  results: EntityRunResult[];
  errors:  { entity: string; scope: string; message: string }[];
}

async function uploadRun(cfg: AgentConfig, args: {
  kind: string; scope: string | null; startedAt: Date; finishedAt: Date;
  status: 'ok' | 'error'; rows_total: number; rows_upserted: number; message: string | null;
}): Promise<void> {
  await uploadBatch(cfg, 'run', [{
    kind:           args.kind,
    scope:          args.scope,
    started_at:     args.startedAt.toISOString(),
    finished_at:    args.finishedAt.toISOString(),
    status:         args.status,
    rows_total:     args.rows_total,
    rows_upserted:  args.rows_upserted,
    message:        args.message,
    params:         {},
  }]).catch((e) => log('warn', `failed to upload run summary: ${e.message}`));
}

export async function runAll(cfg: AgentConfig, mode: 'incr' | 'full'): Promise<RunSummary> {
  // Pre-flight 1: skip if customer is currently logged in via noVNC. The
  // login service holds an exclusive lock on chrome-profile; if we open
  // Chrome (headless) we'd race for the profile and either crash or corrupt.
  if (existsSync(LOGIN_LOCK)) {
    log('warn', 'login mode active (login.lock exists) — skipping crawl tick. Will retry next cron.');
    return { ok: true, results: [], errors: [{ entity: 'preflight', scope: 'login_lock', message: 'login mode active' }] };
  }

  // Pre-flight 2: skip if no FB session yet (filesystem check, no Chrome boot).
  // On a low-RAM VPS even a brief Playwright launch can OOM the box.
  if (!profileLooksLoggedIn()) {
    log('warn', 'chrome-profile looks empty (no FB login yet). Skipping crawl. Run `systemctl start auto-facebook-agent-login`, login via noVNC, then `systemctl restart auto-facebook-agent`');
    return { ok: true, results: [], errors: [{ entity: 'preflight', scope: 'session', message: 'no FB session' }] };
  }

  // Refresh owner profile (name + avatar) if stale (>7 days) — chrome will be
  // up shortly anyway, so the extra navigation is cheap.
  void fetchOwnerProfile().catch(() => {});

  let client = await createFbClient();
  const summary: RunSummary = { ok: true, results: [], errors: [] };
  try {
    // Discover joined groups first (rare-but-needed) — cloud's runner skips it
    // for budget reasons because it triggers manually; on agent we still skip
    // it on every tick (run via /api/run if/when we expose that to customer).
    // For now: run discovery on every FULL only.
    if (mode === 'full') {
      const discoverEntity = ENTITIES.find((e) => e.name === 'fb_joined_groups');
      if (discoverEntity) {
        const startedAt = new Date();
        try {
          const r = await discoverEntity.run({ client, cfg, scope: 'global', mode });
          summary.results.push(r);
          await uploadRun(cfg, { kind: `${discoverEntity.name}:${mode}`, scope: null, startedAt, finishedAt: new Date(), status: 'ok', rows_total: r.rows_seen, rows_upserted: r.rows_upserted, message: null });
        } catch (e: any) {
          summary.ok = false;
          summary.errors.push({ entity: discoverEntity.name, scope: 'global', message: String(e?.message ?? e) });
          await uploadRun(cfg, { kind: `${discoverEntity.name}:${mode}`, scope: null, startedAt, finishedAt: new Date(), status: 'error', rows_total: 0, rows_upserted: 0, message: String(e?.message ?? e) });
          if (e instanceof BudgetExceededError || e instanceof SessionWallError) throw e;
        }
      }
    }

    // Per-group entities — fetch enabled groups from cloud
    const groups = await fetchGroupsToCrawl(cfg);
    log('info', `runAll(${mode}): ${groups.length} enabled groups to crawl`);
    setRunProgress(0, groups.length, null);
    for (let i = 0; i < groups.length; i++) {
      const gid = groups[i];
      setRunProgress(i, groups.length, gid);
      for (const entity of ENTITIES) {
        if (entity.name === 'fb_joined_groups') continue;
        // Comments are ~7x slower than posts (~10min vs ~1.5min per group) and
        // only feed the weekly insight analysis — not lead detection. Skip them
        // on frequent incr runs so posts (→ leads) crawl fast; they're refreshed
        // during the nightly full sweep. Override with AGENT_INCR_COMMENTS=true.
        if (mode === 'incr'
            && entity.name === 'fb_group_post_comment'
            && process.env.AGENT_INCR_COMMENTS !== 'true') continue;
        const startedAt = new Date();
        const label = `${entity.name}(${gid})`;
        try {
          const r = await withTimeout(entity.run({ client, cfg, scope: gid, mode }), ENTITY_TIMEOUT_MS, label);
          summary.results.push(r);
          await uploadRun(cfg, { kind: `${entity.name}:${mode}`, scope: gid, startedAt, finishedAt: new Date(), status: 'ok', rows_total: r.rows_seen, rows_upserted: r.rows_upserted, message: null });
          log('info', `${label}: ${r.rows_upserted}/${r.rows_seen} rows in ${r.pages_scanned} pages`);
        } catch (e: any) {
          summary.ok = false;
          summary.errors.push({ entity: entity.name, scope: gid, message: String(e?.message ?? e) });
          await uploadRun(cfg, { kind: `${entity.name}:${mode}`, scope: gid, startedAt, finishedAt: new Date(), status: 'error', rows_total: 0, rows_upserted: 0, message: String(e?.message ?? e) });
          log('error', `${label} failed: ${e?.message}`);
          // Timeout: current Chrome client is likely wedged on a stuck
          // page.evaluate. Close + recreate it so the next group gets a fresh
          // browser. Without this, every subsequent group hits the same hang
          // and the whole sweep produces nothing.
          if (e instanceof EntityTimeoutError) {
            log('warn', `${label}: recreating Chrome client after timeout`);
            try { await withTimeout(client.close(),       30_000, 'client.close on timeout'); } catch {}
            try { await withTimeout(closeBrowserContext(), 30_000, 'closeBrowserContext on timeout'); } catch {}
            client = await createFbClient();
            break; // skip remaining entities for this group; move to next group
          }
          if (e instanceof BudgetExceededError || e instanceof SessionWallError) throw e;
        }
      }
      setRunProgress(i + 1, groups.length, null);
    }
  } finally {
    // Close the page first, then tear down the entire browser context.
    // This frees ALL Chrome RAM — agent goes back to ~150MB idle until next
    // cron tick (~2h). Without this, Chrome's ~1GB stays resident forever.
    await client.close();
    await closeBrowserContext();
    log('info', 'chrome closed — agent back to idle baseline');
  }
  return summary;
}

/**
 * Lightweight: rescan the user's joined-groups list only (no per-group post
 * crawl). Used by dashboard "Refresh groups list" button — completes in
 * ~30-60s so newly-joined groups appear in the Groups tab within ~1 min.
 */
export async function runDiscoverOnly(cfg: AgentConfig): Promise<RunSummary> {
  if (existsSync(LOGIN_LOCK)) {
    log('warn', 'discover-only: login mode active — skipping (caller should stop login service first)');
    return { ok: true, results: [], errors: [{ entity: 'preflight', scope: 'login_lock', message: 'login mode active' }] };
  }
  if (!profileLooksLoggedIn()) {
    log('warn', 'discover-only: chrome-profile looks empty — skipping');
    return { ok: true, results: [], errors: [{ entity: 'preflight', scope: 'session', message: 'no FB session' }] };
  }

  const discoverEntity = ENTITIES.find((e) => e.name === 'fb_joined_groups');
  if (!discoverEntity) return { ok: true, results: [], errors: [] };

  void fetchOwnerProfile().catch(() => {});

  let client = await createFbClient();
  const summary: RunSummary = { ok: true, results: [], errors: [] };
  try {
    const startedAt = new Date();
    try {
      const r = await discoverEntity.run({ client, cfg, scope: 'global', mode: 'full' });
      summary.results.push(r);
      await uploadRun(cfg, { kind: `${discoverEntity.name}:full`, scope: null, startedAt, finishedAt: new Date(), status: 'ok', rows_total: r.rows_seen, rows_upserted: r.rows_upserted, message: 'dashboard refresh' });
      log('info', `discover-only: ${r.rows_upserted}/${r.rows_seen} groups`);
    } catch (e: any) {
      summary.ok = false;
      summary.errors.push({ entity: discoverEntity.name, scope: 'global', message: String(e?.message ?? e) });
      await uploadRun(cfg, { kind: `${discoverEntity.name}:full`, scope: null, startedAt, finishedAt: new Date(), status: 'error', rows_total: 0, rows_upserted: 0, message: String(e?.message ?? e) });
    }
  } finally {
    await client.close();
    await closeBrowserContext();
    log('info', 'discover-only: chrome closed');
  }
  return summary;
}
