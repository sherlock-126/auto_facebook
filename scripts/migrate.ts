import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { pool } from '../src/db.js';

async function main() {
  const dir = join(process.cwd(), 'sql');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    console.log(`-- applying ${f}`);
    const sql = readFileSync(join(dir, f), 'utf8');
    await pool.query(sql);
  }
  console.log('migrations done');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
