/**
 * Lead detector — bridge between scraped posts and the lead pipeline.
 *
 * Hooked into fb_group_post entity: after a post is upserted, we call
 * `maybeCreateLead()`. It is idempotent (UNIQUE constraint on post_id) and
 * fire-and-forget (errors logged, never propagated to caller — the scrape
 * itself must not fail because the LLM is unhappy).
 */
import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { classifyMessage, classifyWithRules, classifierConfigured } from './classifier.js';
import { getTenantConfig } from './pipeline.js';
import { sendLeadAlertFireAndForget } from './notifier.js';

// Normalized content fingerprint for de-dup. MUST stay in sync with the SQL
// backfill in sql/011_lead_dedup.sql: trim → collapse whitespace → lowercase.
function normalizeContent(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}
function hashContent(message: string): string {
  return createHash('md5').update(normalizeContent(message)).digest('hex');
}

async function markClassifierFailed(postId: string): Promise<void> {
  await pool.query(
    `UPDATE fact_group_post SET classifier_failed_at = NOW() WHERE post_id = $1`,
    [postId],
  ).catch((e) => console.warn(`[lead-detector] mark failed: ${e?.message ?? e}`));
}

/**
 * Normalize an org/company name for matching: lowercase + strip Vietnamese
 * diacritics + collapse whitespace. "HUTATO" / "hutato" / "Hutato Co." all
 * collapse to "hutato" / "hutato co". Limited to 50 chars to keep index slim.
 * Returns null when input is too short/empty (avoid matching on noise like "a").
 */
export function normalizeOrgName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = String(raw)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  return n.length >= 3 ? n : null;
}

// Posts ≥ this many normalized chars de-dup on CONTENT ALONE (ignoring author):
// recruiters rotate FB accounts to re-post the same long ad, so author_id is
// unreliable. Shorter posts keep author scoping to avoid merging two distinct
// buyers who happen to use near-identical short phrasing.
const MIN_CONTENT_ONLY_DEDUP_LEN = 100;

// In-process reservation of dedup keys currently being classified. The crawl
// fires maybeCreateLead() concurrently for every post in a batch (fire-and-
// forget loop in upload.ts / fb_group_post.ts). Without this, N identical
// reposts in one batch all pass the DB dedup check before any INSERT commits,
// then all insert → N leads. The synchronous has()+add() (no await between)
// makes the check-and-reserve atomic, so only the first concurrent caller wins.
const inFlightDedup = new Set<string>();

export interface PostForLead {
  post_id: string;
  group_id: string;
  group_name?: string | null;
  author_id: string | null;
  message: string | null;
  tenant_id?: string;
}

export async function maybeCreateLead(post: PostForLead): Promise<void> {
  const tenantId = post.tenant_id;
  if (!tenantId) throw new Error('maybeCreateLead: post.tenant_id is required');
  if (!post.message || post.message.trim().length === 0) return;

  const cfg = await getTenantConfig(tenantId);
  if (!cfg.classifier_enabled) return;

  // Skip if already classified — UNIQUE (post_id) handles dedupe, but check
  // here to avoid hitting Gemini for posts we've already processed. We also
  // grab the post's created_time in the same query to enforce the recency
  // filter without an extra round-trip.
  const { rows: existing } = await pool.query(
    `SELECT l.lead_id, l.classified_at, p.created_time, p.permalink, p.classifier_failed_at
       FROM fact_group_post p
       LEFT JOIN fact_lead l ON l.post_id = p.post_id AND l.tenant_id = $2
      WHERE p.post_id = $1`,
    [post.post_id, tenantId]
  );
  if (existing[0]?.classified_at) return;
  // Backoff: if a recent classifier attempt failed (Gemini 503 etc), skip this
  // post for 1h. Avoids burning quota re-trying the same post crawl-after-
  // crawl during an upstream outage.
  const failedAt = existing[0]?.classifier_failed_at as Date | null | undefined;
  if (failedAt && (Date.now() - new Date(failedAt).getTime()) < 60 * 60 * 1000) return;
  const wasNew = !existing[0]?.lead_id; // capture BEFORE upsert — xmax-based detection unreliable in PG13+ with ON CONFLICT
  const createdTime = existing[0]?.created_time as Date | null | undefined;

  // Recency filter: skip posts older than lead_max_age_days. 0 disables.
  const maxAgeDays = typeof cfg.lead_max_age_days === 'number' ? cfg.lead_max_age_days : 7;
  if (maxAgeDays > 0 && createdTime) {
    const ageDays = (Date.now() - new Date(createdTime).getTime()) / 86_400_000;
    if (ageDays > maxAgeDays) return; // too old → no Gemini call, no lead
  }

  // Author-level blocklist: customer marked posts from this FB account as spam
  // → skip silently before paying for a Gemini call.
  if (post.author_id) {
    const { rows: blkAuthor } = await pool.query(
      `SELECT 1 FROM lead_blocklist
        WHERE tenant_id = $1 AND scope = 'author' AND pattern = $2 LIMIT 1`,
      [tenantId, post.author_id],
    );
    if (blkAuthor.length) return;
  }

  const dedupDays = typeof cfg.lead_dedup_days === 'number' ? cfg.lead_dedup_days : 7;
  const dedupEnabled = dedupDays > 0;

  // Layer 3 — per-author cooldown. Same FB account already produced a lead in
  // the past `lead_dedup_days` → silent skip (no Gemini call, no Telegram).
  // Catches recruiters who post different JDs (seller vs designer vs nhân sự)
  // from the same account: text differs → Layer 1 misses, brand is null → Layer
  // 2 misses, but author_id matches. Anonymous posts (null author) fall through.
  if (dedupEnabled && post.author_id) {
    // Exclude closed_won so a real customer who bought from us can still
    // re-engage with a follow-up question on a different product. closed_lost
    // is kept in the count — if customer wanted hard suppression they'd have
    // added to blocklist; closed_lost may mean "lost deal" or "spam I didn't
    // bother to block", both want continued suppression.
    const { rows: authorDup } = await pool.query(
      `SELECT 1 FROM fact_lead
        WHERE tenant_id = $1 AND author_id = $2
          AND (stage IS NULL OR stage <> 'closed_won')
          AND detected_at > NOW() - ($3::text || ' days')::interval
        LIMIT 1`,
      [tenantId, post.author_id, String(dedupDays)],
    );
    if (authorDup.length) return;
  }

  // De-dup filter: recruiters re-post identical ads many times (different
  // post_id, often rotating across multiple FB accounts). If we already created
  // a lead for this exact content within lead_dedup_days, skip entirely — no
  // Gemini call, no new lead, no Telegram alert. 0 disables.
  //   - Long posts (≥100 chars): match on content alone (author unreliable).
  //   - Short posts: match on author+content (avoid merging distinct buyers).
  const contentHash = hashContent(post.message);
  const normLen = normalizeContent(post.message).length;
  const contentOnly = normLen >= MIN_CONTENT_ONLY_DEDUP_LEN;
  const dedupKey = contentOnly
    ? `${tenantId}:c:${contentHash}`
    : `${tenantId}:a:${post.author_id ?? ''}:${contentHash}`;

  // Atomic reserve (synchronous has()+add()) — guards against concurrent
  // identical reposts in the same crawl batch.
  let reserved = false;
  if (dedupEnabled) {
    if (inFlightDedup.has(dedupKey)) return; // a concurrent caller owns this content
    inFlightDedup.add(dedupKey);
    reserved = true;
  }

  try {
    if (dedupEnabled) {
      const { rows: dup } = contentOnly
        ? await pool.query(
            `SELECT 1 FROM fact_lead
              WHERE tenant_id = $1 AND content_hash = $2
                AND detected_at > NOW() - ($3::text || ' days')::interval
              LIMIT 1`,
            [tenantId, contentHash, String(dedupDays)]
          )
        : await pool.query(
            `SELECT 1 FROM fact_lead
              WHERE tenant_id = $1 AND content_hash = $2
                AND author_id IS NOT DISTINCT FROM $3
                AND detected_at > NOW() - ($4::text || ' days')::interval
              LIMIT 1`,
            [tenantId, contentHash, post.author_id ?? null, String(dedupDays)]
          );
      if (dup.length) return; // duplicate of an existing lead → suppress
    }

    // Two paths:
    //  - cfg.lead_rules non-empty → rules-based (customer-written description + Gemini)
    //  - else → legacy 7-intent enum classifier
    const useRules = typeof cfg.lead_rules === 'string' && cfg.lead_rules.trim().length > 30;
    const minConf  = typeof cfg.lead_min_confidence === 'number' ? cfg.lead_min_confidence : 0;

    let intentStr: string;
    let confidence: number;
    let reason: string;
    let entities: any;
    let shouldCreate: boolean;

    if (useRules) {
      const r = await classifyWithRules(post.message, cfg.lead_rules!, { group_name: post.group_name ?? undefined, tenant_id: tenantId });
      if (!r) {
        if (classifierConfigured()) console.warn(`[lead-detector] rules-classifier null for post ${post.post_id}`);
        await markClassifierFailed(post.post_id);
        return;
      }
      intentStr    = r.category;
      confidence   = r.confidence;
      reason       = r.reason;
      entities     = r.entities;
      shouldCreate = r.is_lead && r.confidence >= minConf;
    } else {
      const r = await classifyMessage(post.message, { group_name: post.group_name ?? undefined, tenant_id: tenantId });
      if (!r) {
        if (classifierConfigured()) console.warn(`[lead-detector] enum-classifier null for post ${post.post_id}`);
        await markClassifierFailed(post.post_id);
        return;
      }
      intentStr    = r.intent;
      confidence   = r.confidence;
      reason       = r.reason;
      entities     = r.entities;
      shouldCreate = cfg.lead_intents.includes(r.intent) && r.confidence >= minConf;
    }
    // Classifier returned a result (lead or not) → clear any past failure marker.
    if (failedAt) await pool.query(`UPDATE fact_group_post SET classifier_failed_at = NULL WHERE post_id = $1`, [post.post_id]);

    if (!shouldCreate) return; // classified but doesn't match criteria — caching done in classifier

    // Org-level dedup + blocklist (Layer 2 — catches reworded reposts of the
    // same company that Layer 1 content-hash dedup missed). Runs AFTER the
    // Gemini call (which extracts entities.org_name) but BEFORE INSERT, so the
    // wasted-Gemini-call cost is bounded to 1 per dup, not N per dup.
    const orgRaw = (entities && typeof entities === 'object') ? (entities.org_name ?? null) : null;
    const orgNorm = normalizeOrgName(orgRaw);
    if (orgNorm) {
      const { rows: blkOrg } = await pool.query(
        `SELECT 1 FROM lead_blocklist
          WHERE tenant_id = $1 AND scope = 'org' AND pattern = $2 LIMIT 1`,
        [tenantId, orgNorm],
      );
      if (blkOrg.length) return; // blocklist hit → suppress (no INSERT, no Telegram alert)
      if (dedupEnabled) {
        const { rows: orgDup } = await pool.query(
          `SELECT 1 FROM fact_lead
            WHERE tenant_id = $1 AND org_name_norm = $2
              AND detected_at > NOW() - ($3::text || ' days')::interval
            LIMIT 1`,
          [tenantId, orgNorm, String(dedupDays)],
        );
        if (orgDup.length) return; // same org within dedup window → suppress
      }
    }

    const { rows } = await pool.query(
    `INSERT INTO fact_lead
       (tenant_id, post_id, group_id, author_id,
        intent, intent_confidence, intent_reason, intent_entities,
        content_hash, org_name, org_name_norm, classified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, now())
     ON CONFLICT (tenant_id, post_id) DO UPDATE
       SET intent            = EXCLUDED.intent,
           intent_confidence = EXCLUDED.intent_confidence,
           intent_reason     = EXCLUDED.intent_reason,
           intent_entities   = EXCLUDED.intent_entities,
           content_hash      = EXCLUDED.content_hash,
           org_name          = EXCLUDED.org_name,
           org_name_norm     = EXCLUDED.org_name_norm,
           classified_at     = EXCLUDED.classified_at,
           updated_at        = now()
     RETURNING lead_id`,
    [
      tenantId,
      post.post_id,
      post.group_id,
      post.author_id,
      intentStr,
      confidence,
      reason,
      JSON.stringify(entities),
      contentHash,
      orgRaw ? String(orgRaw).slice(0, 80) : null,
      orgNorm,
    ]
  );
    const leadId = rows[0]?.lead_id;
    if (leadId && wasNew) {
      await pool.query(
        `INSERT INTO lead_history (lead_id, action, to_value, note, actor)
         VALUES ($1, 'created', $2, $3, 'system')`,
        [leadId, intentStr, `auto-detected (${confidence.toFixed(2)}) ${useRules ? '[rules]' : '[enum]'}`]
      );
      sendLeadAlertFireAndForget(tenantId, leadId);

      // Fire-and-forget: if tenant enabled auto-reply, generate AI suggestion +
      // queue for manual approval. Errors logged but never block lead creation.
      if (cfg.auto_reply_enabled) {
        void import('../ai/reply_generator.js').then(({ generateAndQueueReply }) =>
          generateAndQueueReply({
            tenantId,
            leadId,
            postId:        post.post_id,
            postPermalink: existing[0]?.permalink ?? null,
            postMessage:   post.message!,
            authorName:    null, // detector doesn't have name; reply generator can fallback
            groupName:     post.group_name ?? null,
            intent:        intentStr,
          })
        ).catch((e) => console.warn(`[detector] reply_generator failed: ${e?.message ?? e}`));
      }
    }
  } finally {
    if (reserved) inFlightDedup.delete(dedupKey);
  }
}

/**
 * Fire-and-forget wrapper for ETL callers — never throws, never blocks long.
 */
export function maybeCreateLeadFireAndForget(post: PostForLead): void {
  void maybeCreateLead(post).catch((e) => {
    console.error(`[lead-detector] fire-and-forget failed for post ${post.post_id}:`, e?.message ?? e);
  });
}
