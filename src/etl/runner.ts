import { pool } from '../db.js';
import { createFbClient, SessionWallError } from '../fb/client.js';
import { BudgetExceededError } from '../fb/budget.js';
import { ENTITIES, findEntity, type EntityRunResult } from './entity_registry.js';

export interface RunSummary {
  ok: boolean;
  results: EntityRunResult[];
  errors: { entity: string; scope: string; message: string }[];
}

async function listEnabledGroups(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT group_id FROM dim_group
      WHERE tenant_id = $1 AND enabled = TRUE AND is_joined = TRUE AND deleted_at IS NULL
      ORDER BY first_seen_at`,
    [tenantId]
  );
  return rows.map((r) => r.group_id as string);
}

async function logRunStart(kind: string, scope: string, params: any): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO etl_run (kind, scope, params) VALUES ($1, $2, $3) RETURNING id`,
    [kind, scope, params]
  );
  return rows[0].id;
}
async function logRunFinish(id: number, status: string, message: string | null, total: number, upserted: number) {
  await pool.query(
    `UPDATE etl_run SET finished_at = now(), status = $2, message = $3, rows_total = $4, rows_upserted = $5 WHERE id = $1`,
    [id, status, message, total, upserted]
  );
}

export async function runAll(mode: 'incr' | 'full', tenantId: string): Promise<RunSummary> {
  if (!tenantId) throw new Error('runAll: tenantId required');
  const client = await createFbClient();
  const summary: RunSummary = { ok: true, results: [], errors: [] };
  try {
    // NOTE: fb_joined_groups is intentionally NOT auto-run per tick — the
    // user manually triggers it from the Groups tab when they join/leave
    // groups (rare, ~weekly). Saves ~96 calls/day of budget. The manual
    // trigger goes through /api/run with entity=fb_joined_groups.

    // Per-group entities (scoped to this tenant)
    const groups = await listEnabledGroups(tenantId);
    for (const gid of groups) {
      for (const entity of ENTITIES) {
        if (entity.name === 'fb_joined_groups') continue;
        const runId = await logRunStart(`${entity.name}:${mode}`, gid, { mode });
        try {
          const r = await entity.run({ client, scope: gid, mode, tenantId });
          summary.results.push(r);
          await logRunFinish(runId, 'ok', null, r.rows_seen, r.rows_upserted);
        } catch (e: any) {
          summary.ok = false;
          summary.errors.push({ entity: entity.name, scope: gid, message: String(e?.message ?? e) });
          await logRunFinish(runId, 'error', String(e?.message ?? e), 0, 0);
          if (e instanceof BudgetExceededError || e instanceof SessionWallError) throw e;
        }
      }
    }
  } finally {
    await client.close();
  }
  return summary;
}

export async function runOne(entityName: string, scope: string, mode: 'incr' | 'full', tenantId?: string): Promise<EntityRunResult> {
  const entity = findEntity(entityName);
  if (!entity) throw new Error(`Unknown entity: ${entityName}`);
  const tid = tenantId ?? process.env.DEFAULT_TENANT_ID ?? 'tu-n';
  const client = await createFbClient();
  const runId = await logRunStart(`${entityName}:${mode}`, scope, { mode, ad_hoc: true });
  try {
    const r = await entity.run({ client, scope, mode, tenantId: tid });
    await logRunFinish(runId, 'ok', null, r.rows_seen, r.rows_upserted);
    return r;
  } catch (e: any) {
    await logRunFinish(runId, 'error', String(e?.message ?? e), 0, 0);
    throw e;
  } finally {
    await client.close();
  }
}
