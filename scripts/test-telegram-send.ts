import { pool } from '../src/db.js';
import { maybeCreateLead } from '../src/leads/detector.js';
import { sendLeadAlertFireAndForget } from '../src/leads/notifier.js';

const POST_IDS = [
  '1490862642195316', // YF INC Tuyển Designer POD
  '1002285129221158', // OUTBOXIAN Tuyển Design POD
  '1458460452188651', // AN PHÁT Tuyển Design POD/EMB
  '1491727428775504', // Tuyển Designer POD Etsy/TikTok
  '827925933122516',  // tìm sup phonecase / airpod (already lead 288)
];

async function main() {
  const { rows: posts } = await pool.query(
    `SELECT post_id, group_id, author_id, message FROM fact_group_post
      WHERE tenant_id='tu-n' AND post_id = ANY($1::text[])`,
    [POST_IDS]
  );

  for (const p of posts) {
    console.log(`\n→ post ${p.post_id}`);
    // 1. Ensure a lead row exists (creates + auto-fires alert if new)
    await maybeCreateLead({
      post_id:   p.post_id,
      group_id:  p.group_id,
      author_id: p.author_id,
      message:   p.message,
      tenant_id: 'tu-n',
    });

    // 2. If lead already existed (no auto-fire), send alert manually so user
    //    sees notification regardless of insert-vs-skip.
    const { rows: lead } = await pool.query(
      `SELECT lead_id FROM fact_lead WHERE tenant_id='tu-n' AND post_id=$1`,
      [p.post_id]
    );
    if (lead[0]) {
      console.log(`   lead_id=${lead[0].lead_id} — firing alert`);
      sendLeadAlertFireAndForget('tu-n', lead[0].lead_id);
    } else {
      console.log('   (no lead created — maybe not classified as lead)');
    }
  }

  // Give fire-and-forget alerts a few seconds to send before pool close
  await new Promise((r) => setTimeout(r, 8000));
  await pool.end();
  console.log('\nDone. Check Telegram.');
}

main().catch((e) => { console.error(e); process.exit(1); });
