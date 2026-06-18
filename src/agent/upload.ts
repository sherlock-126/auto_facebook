/**
 * /api/agent/upload + helper read-endpoints.
 *
 * The agent (running on the customer's VPS) calls these to push scraped data
 * into the cloud DB. All UPSERTs are scoped to req.tenant_id (resolved by
 * requireAgent middleware from Bearer license_key).
 *
 * Defensive: when an existing row already exists for a different tenant
 * (legacy single-PK schema for dim_group / fact_group_post / fact_group_post_comment),
 * the UPSERT explicitly checks tenant ownership and refuses cross-tenant overwrites.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { upsertBatch } from '../etl/upsert.js';
import { maybeCreateLeadFireAndForget } from '../leads/detector.js';
import { requireAgent } from './middleware.js';

const RL = { rateLimit: { max: 60, timeWindow: '1 minute' } } as const;

interface UploadBody {
  entity?: string;
  rows?: unknown;
}

type Entity = 'groups' | 'posts' | 'comments' | 'run';
const ENTITY_TABLES: Record<Entity, { table: string; key: string }> = {
  groups:   { table: 'dim_group',               key: 'group_id' },
  posts:    { table: 'fact_group_post',         key: 'post_id' },
  comments: { table: 'fact_group_post_comment', key: 'comment_id' },
  run:      { table: 'etl_run',                 key: 'id' }, // INSERT-only, not UPSERT
};

export async function registerAgentUploadRoutes(app: FastifyInstance): Promise<void> {
  // ---- UPLOAD ----
  app.post<{ Body: UploadBody }>(
    '/api/agent/upload',
    { preHandler: requireAgent, config: RL as any },
    async (req, reply) => {
      const tid = req.tenant_id!;
      const entity = String(req.body?.entity ?? '') as Entity;
      const rows = Array.isArray(req.body?.rows) ? (req.body!.rows as Record<string, unknown>[]) : null;
      if (!ENTITY_TABLES[entity]) return reply.status(400).send({ error: 'unknown_entity', allowed: Object.keys(ENTITY_TABLES) });
      if (!rows) return reply.status(400).send({ error: 'rows_must_be_array' });
      if (rows.length === 0) return { ok: true, upserted: 0 };
      if (rows.length > 5000) return reply.status(413).send({ error: 'batch_too_large', limit: 5000 });

      try {
        if (entity === 'run') {
          // INSERT-only — one or many run-summary rows.
          let inserted = 0;
          for (const r of rows) {
            await pool.query(
              `INSERT INTO etl_run
                 (tenant_id, kind, scope, started_at, finished_at, status, rows_total, rows_upserted, message, params)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
              [
                tid,
                String(r.kind ?? 'unknown'),
                r.scope ? String(r.scope) : null,
                r.started_at ?? null,
                r.finished_at ?? null,
                String(r.status ?? 'ok'),
                Number(r.rows_total ?? 0),
                Number(r.rows_upserted ?? 0),
                r.message ? String(r.message) : null,
                JSON.stringify(r.params ?? {}),
              ]
            );
            inserted++;
          }
          return { ok: true, inserted };
        }

        // Data entities (groups/posts/comments): composite PK (tenant_id, <fb_id>)
        // means every tenant can independently hold the same FB row — no more
        // cross-tenant collision skip needed (was removed in sql/016_composite_pk.sql).
        const { table, key } = ENTITY_TABLES[entity];
        // Stamp tenant_id on every row (overrides any tenant_id from agent body).
        const stamped = rows.map((r) => ({ ...r, tenant_id: tid }));
        // For dim_group: NEVER overwrite the user's manual enable/disable toggle
        // on re-discover. Agent always sends `enabled: false` as the default for
        // newly-discovered groups; without this guard, every rescan resets all
        // existing groups back to OFF.
        const fields = Object.keys(stamped[0]);
        const updateCols = entity === 'groups'
          ? fields.filter((f) => f !== 'tenant_id' && f !== key && f !== 'enabled')
          : undefined;
        const n = await upsertBatch({ table, keyCols: ['tenant_id', key], rows: stamped, updateCols });

        // Fire-and-forget lead detection on posts.
        if (entity === 'posts') {
          for (const p of rows) {
            const pid = p.post_id ? String(p.post_id) : null;
            const gid = p.group_id ? String(p.group_id) : null;
            if (!pid || !gid) continue;
            maybeCreateLeadFireAndForget({
              post_id:   pid,
              group_id:  gid,
              author_id: p.author_id ? String(p.author_id) : null,
              message:   p.message ? String(p.message) : null,
              tenant_id: tid,
            });
          }
        }

        return { ok: true, upserted: n };
      } catch (e: any) {
        req.log.error({ err: e?.message ?? String(e), entity, rows: rows.length }, 'agent upload failed');
        return reply.status(500).send({ error: 'upload_failed', message: e?.message ?? String(e) });
      }
    }
  );

  // ---- GROUPS TO CRAWL ----
  // Agent reads this on each tick to know which groups (out of all the
  // tenant's joined groups) the user has enabled for crawling.
  app.get('/api/agent/groups-to-crawl', { preHandler: requireAgent }, async (req) => {
    const { rows } = await pool.query(
      `SELECT group_id, name
         FROM dim_group
        WHERE tenant_id = $1
          AND enabled = TRUE
          AND is_joined = TRUE
          AND deleted_at IS NULL
        ORDER BY first_seen_at`,
      [req.tenant_id!]
    );
    return { rows };
  });

  // ---- POSTS TO COMMENT-CRAWL ----
  // Cloud-side equivalent of fb_group_post_comment.ts:listPostsForGroup —
  // returns posts where FB-reported comment_count > number we've actually scraped.
  app.get<{ Querystring: { group_id?: string; limit?: string } }>(
    '/api/agent/posts-for-comments',
    { preHandler: requireAgent },
    async (req, reply) => {
      const gid = req.query.group_id;
      if (!gid) return reply.status(400).send({ error: 'missing_group_id' });
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 40)));
      const { rows } = await pool.query(
        `SELECT p.post_id,
                p.raw->'feedback'->>'id' AS feedback_id,
                p.comment_count,
                COALESCE(c.scraped_count, 0)::int AS scraped_count
           FROM fact_group_post p
           LEFT JOIN (
              SELECT post_id, count(*)::int AS scraped_count
                FROM fact_group_post_comment
               WHERE tenant_id = $1 AND deleted_at IS NULL
               GROUP BY post_id
           ) c USING (post_id)
          WHERE p.tenant_id = $1
            AND p.group_id  = $2
            AND p.deleted_at IS NULL
            AND p.raw->'feedback'->>'id' IS NOT NULL
            AND COALESCE(p.comment_count, 0) > COALESCE(c.scraped_count, 0)
          ORDER BY (COALESCE(p.comment_count, 0) - COALESCE(c.scraped_count, 0)) DESC,
                   p.created_time DESC NULLS LAST
          LIMIT $3`,
        [req.tenant_id!, gid, limit]
      );
      return { rows };
    }
  );
}
