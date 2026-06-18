import { pool } from '../src/db.js';
import { classifyWithRules } from '../src/leads/classifier.js';

const POST_IDS = [
  '827925933122516',  // tìm sup US in phonecase / airpod — rule 1
  '1005962225520115', // POD PHONE CASE Etsy — borderline
  '2024711018436232', // PRINTPOSS xưởng fulfillment — borderline
];

async function main() {
  const { rows: rulesRow } = await pool.query(
    `SELECT config->>'lead_rules' AS rules FROM tenant_settings WHERE tenant_id='tu-n'`
  );
  const rules = rulesRow[0].rules;

  const { rows: posts } = await pool.query(
    `SELECT post_id, substr(message, 1, 600) AS message FROM fact_group_post
      WHERE tenant_id='tu-n' AND post_id = ANY($1::text[])`,
    [POST_IDS]
  );

  console.log(`Testing ${posts.length} posts with rules (${rules.length} chars)\n`);

  for (const p of posts) {
    process.stdout.write(`\n──── post ${p.post_id} ────\n`);
    process.stdout.write(p.message.substring(0, 180).replace(/\n+/g, ' ') + '...\n');
    try {
      const r = await classifyWithRules(p.message, rules, { bypass_cache: true });
      if (!r) { console.log('  → (null — classifier off?)'); continue; }
      const tag = r.is_lead ? '🎯 LEAD' : '⏭  not';
      console.log(`  ${tag}  conf=${(r.confidence * 100).toFixed(0)}%  cat="${r.category}"`);
      console.log(`  reason: ${r.reason}`);
    } catch (e: any) {
      console.log('  → ERROR: ' + e.message);
    }
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
