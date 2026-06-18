// One-shot reclassify-all for tenant 'tu-n' (CLI bypass for the HTTP endpoint).
// Honors the new lead_max_age_days filter — old posts skipped silently.
import { pool } from '../src/db.js';
import { maybeCreateLead } from '../src/leads/detector.js';

const TENANT = 'tu-n';

async function main() {
  console.log(`▶ reclassify-all for tenant=${TENANT}`);

  const del1 = await pool.query(`DELETE FROM fact_lead WHERE tenant_id = $1`, [TENANT]);
  console.log(`  deleted ${del1.rowCount} leads`);

  const del2 = await pool.query(`DELETE FROM lead_classifier_cache WHERE model LIKE 'rules:%'`);
  console.log(`  deleted ${del2.rowCount} rules cache entries`);

  const { rows: posts } = await pool.query(
    `SELECT p.post_id, p.group_id, p.author_id, p.message, g.name AS group_name
       FROM fact_group_post p LEFT JOIN dim_group g ON g.group_id = p.group_id
      WHERE p.tenant_id = $1
        AND p.message IS NOT NULL
        AND length(trim(p.message)) > 0
      ORDER BY p.created_time DESC NULLS LAST`,
    [TENANT]
  );
  console.log(`  classifying ${posts.length} posts (newest first)…`);

  const t0 = Date.now();
  let ok = 0, err = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    try {
      await maybeCreateLead({
        post_id:   p.post_id,
        group_id:  p.group_id,
        group_name: p.group_name,
        author_id: p.author_id,
        message:   p.message,
        tenant_id: TENANT,
      });
      ok++;
    } catch (e: any) {
      err++;
      console.warn(`  ! post=${p.post_id}: ${e?.message ?? e}`);
    }
    if ((i + 1) % 25 === 0) {
      const { rows: count } = await pool.query(`SELECT count(*)::int AS n FROM fact_lead WHERE tenant_id=$1`, [TENANT]);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`  [${i + 1}/${posts.length}] ${elapsed}s elapsed · ${count[0].n} leads so far · ok=${ok} err=${err}`);
    }
  }

  const { rows: final } = await pool.query(`SELECT count(*)::int AS n FROM fact_lead WHERE tenant_id=$1`, [TENANT]);
  console.log(`\n✅ Done in ${Math.round((Date.now() - t0) / 1000)}s — ${final[0].n} leads created, ${err} errors`);

  // Give pending Telegram fire-and-forget sends a moment to flush.
  await new Promise((r) => setTimeout(r, 5000));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
