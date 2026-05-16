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
