import { pool } from '../src/db.js';
import { sendLeadAlertFireAndForget } from '../src/leads/notifier.js';

async function main() {
  // Pick first 3 leads with photos to verify sendPhoto path.
  const { rows } = await pool.query(
    `SELECT l.lead_id FROM fact_lead l JOIN fact_group_post p USING (post_id)
      WHERE l.tenant_id='tu-n'
        AND jsonb_path_exists(p.raw, 'strict $.attachments[*].styles.attachment.media.photo_image.uri')
      ORDER BY l.lead_id DESC LIMIT 3`
  );
  for (const r of rows) {
    console.log(`→ firing alert for lead ${r.lead_id}`);
    sendLeadAlertFireAndForget('tu-n', r.lead_id);
  }
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
