import { pool } from '../db.js';

export interface UpsertArgs {
  table: string;
  keyCols: string[];
  rows: Record<string, unknown>[];
  fields?: string[]; // defaults to keys of first row
  updateCols?: string[]; // defaults to all non-key fields
}

export function dedupByKey<T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) seen.set(keys.map((k) => String(r[k] ?? '')).join('|'), r);
  return [...seen.values()];
}

export async function upsertBatch(args: UpsertArgs): Promise<number> {
  if (args.rows.length === 0) return 0;
  const fields = args.fields ?? Object.keys(args.rows[0]);
  const updateCols = args.updateCols ?? fields.filter((f) => !args.keyCols.includes(f));
  const paramsPerRow = fields.length;
  const chunkSize = Math.max(1, Math.floor(60000 / paramsPerRow));
  let total = 0;
  const clean = dedupByKey(args.rows, args.keyCols);
  for (let i = 0; i < clean.length; i += chunkSize) {
    total += await upsertChunk({
      table: args.table,
      keyCols: args.keyCols,
      rows: clean.slice(i, i + chunkSize),
      fields,
      updateCols,
    });
  }
  return total;
}

async function upsertChunk(args: Required<Omit<UpsertArgs, 'rows'>> & { rows: Record<string, unknown>[] }) {
  const { table, keyCols, rows, fields, updateCols } = args;
  const placeholders: string[] = [];
  const values: unknown[] = [];
  let p = 1;
  for (const r of rows) {
    const ps: string[] = [];
    for (const f of fields) {
      ps.push('$' + p++);
      values.push(r[f] ?? null);
    }
    placeholders.push('(' + ps.join(',') + ')');
  }
  const updateClause = updateCols.length
    ? 'DO UPDATE SET ' + updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')
    : 'DO NOTHING';
  const sql = `
    INSERT INTO ${table} (${fields.join(',')})
    VALUES ${placeholders.join(',')}
    ON CONFLICT (${keyCols.join(',')}) ${updateClause}
  `;
  const res = await pool.query(sql, values);
  return res.rowCount ?? 0;
}
