import { pool } from '../db.js';

export async function readWatermark(entity: string, scope: string): Promise<Date | null> {
  const { rows } = await pool.query(
    'SELECT last_cursor_time FROM etl_watermark WHERE entity = $1 AND scope = $2',
    [entity, scope]
  );
  return rows[0]?.last_cursor_time ? new Date(rows[0].last_cursor_time) : null;
}

export async function writeWatermark(args: {
  entity: string;
  scope: string;
  cursor: Date;
  status: 'ok' | 'error';
  count: number;
  error?: string;
}) {
  await pool.query(
    `INSERT INTO etl_watermark (entity, scope, last_cursor_time, last_run_at, last_run_status, last_run_count, last_error)
     VALUES ($1, $2, $3, now(), $4, $5, $6)
     ON CONFLICT (entity, scope) DO UPDATE SET
       last_cursor_time = GREATEST(etl_watermark.last_cursor_time, EXCLUDED.last_cursor_time),
       last_run_at      = EXCLUDED.last_run_at,
       last_run_status  = EXCLUDED.last_run_status,
       last_run_count   = EXCLUDED.last_run_count,
       last_error       = EXCLUDED.last_error`,
    [args.entity, args.scope, args.cursor, args.status, args.count, args.error ?? null]
  );
}
