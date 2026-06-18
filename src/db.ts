import pg from 'pg';
import 'dotenv/config';

// PG returns DATE as JS Date in local TZ by default -> off-by-one bugs.
// Force string for DATE (OID 1082).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  host: process.env.PG_HOST ?? '127.0.0.1',
  port: Number(process.env.PG_PORT ?? 5434),
  database: process.env.PG_DATABASE ?? 'fb_warehouse',
  user: process.env.PG_USER ?? 'fb_etl',
  password: process.env.PG_PASSWORD ?? '',
  max: 10,
});

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a transaction where `app.tenant_id` is set to `tenantId`.
 *
 * **Important caveat:** the app currently connects as `fb_etl` which OWNS
 * the tenant tables. Postgres RLS is bypassed for table owners unless we
 * `ALTER TABLE … FORCE ROW LEVEL SECURITY` — but doing so breaks every
 * existing `pool.query()` call that doesn't go through this wrapper. So in
 * the current single-role architecture, this wrapper IS NOT an enforcement
 * mechanism, only documentation + future-proofing.
 *
 * The actual security boundary is the explicit `WHERE tenant_id = $X` filter
 * in every query. Those filters were audited in 2026-06-01 (4 leaks fixed).
 *
 * **When to use:** for NEW code paths where you want the option to enable
 * RLS enforcement later (after introducing a non-owner role like `fb_app`
 * + FORCE RLS — a bigger migration). Calling withTenant() now does the
 * set_config GUC dance harmlessly; once the role split lands, this same
 * code instantly becomes the security boundary.
 *
 *   await withTenant(tenantId, async (db) => {
 *     const r = await db.query('SELECT * FROM fact_lead WHERE stage = $1', ['new']);
 *     return r.rows;
 *   });
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error('withTenant: tenantId required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(name, value, is_local=true) → scoped to current transaction.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
