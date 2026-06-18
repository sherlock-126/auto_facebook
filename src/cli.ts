import 'dotenv/config';
import { runAll, runOne } from './etl/runner.js';
import { pool } from './db.js';

const USAGE = `
Usage:
  tsx src/cli.ts facts:all:incr        Run all entities for all enabled targets (incremental)
  tsx src/cli.ts facts:all:full        Same but full mode
  tsx src/cli.ts run <entity> <scope> [incr|full]
                                       Ad-hoc single run

Examples:
  tsx src/cli.ts facts:all:incr
  tsx src/cli.ts run fb_page_post vnexpress incr
`;

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'facts:all:incr') {
      const tid = process.env.DEFAULT_TENANT_ID ?? process.argv[3];
      if (!tid) throw new Error('Usage: facts:all:incr <tenantId>  (or set DEFAULT_TENANT_ID env)');
      const r = await runAll('incr', tid);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'facts:all:full') {
      const tid = process.env.DEFAULT_TENANT_ID ?? process.argv[3];
      if (!tid) throw new Error('Usage: facts:all:full <tenantId>  (or set DEFAULT_TENANT_ID env)');
      const r = await runAll('full', tid);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'run') {
      const entity = process.argv[3];
      const scope = process.argv[4];
      const mode = (process.argv[5] ?? 'incr') as 'incr' | 'full';
      if (!entity || !scope) {
        console.error(USAGE);
        process.exit(2);
      }
      const r = await runOne(entity, scope, mode);
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
