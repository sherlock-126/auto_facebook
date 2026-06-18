/**
 * Entity: fb_group_post_comment
 *
 * For each post in the group with comment_count > 0, fetch all comments.
 * Scope = group_id.
 *
 * Endpoints wired from discover captures 2026-05-17:
 *   - CommentListComponentsRootQuery        (doc_id 26692082413774551)
 *       initial load — 1 call returns ~10 comments + cursor
 *   - CommentsListComponentsPaginationQuery (doc_id 27028629270108409)
 *       loads further pages until has_next_page=false
 *
 * Both use the post's *feedback id* (base64(`feedback:${post_id}`)) as the
 * `id` variable, NOT the raw post_id. We read it back from `fact_group_post.raw`
 * to avoid re-encoding errors.
 *
 * Per-post budget: cap pages to keep total run time bounded; a post with
 * 500 comments can otherwise eat the entire daily budget alone.
 */
import { pool } from '../../db.js';
import { upsertBatch } from '../upsert.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

const DOC_ROOT       = '26692082413774551';
const DOC_PAGINATION = '27028629270108409';
const FN_ROOT        = 'CommentListComponentsRootQuery';
const FN_PAGINATION  = 'CommentsListComponentsPaginationQuery';

// Persisted-query providers FB requires inside `variables` (else returns
// "missing_required_variable_value"). Captured 1:1 from the discover sample.
const RELAY_PROVIDERS: Record<string, unknown> = {
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
  __relay_internal__pv__IsWorkUserrelayprovider: false,
};

// Both modes prioritise posts where DB count lags actual FB count
// (see SQL ORDER BY in listPostsForGroup). Caps are safety bounds; the
// daily budget in budget.ts is the real ceiling.
const MAX_POSTS_PER_RUN_INCR = 40;
const MAX_POSTS_PER_RUN_FULL = 200;
const MAX_PAGES_PER_POST     = 10;

interface ParsedComment {
  comment_id: string;
  post_id: string;
  parent_comment_id: string | null;
  author_id: string | null;
  message: string | null;
  created_time: Date | null;
  reaction_count: number | null;
  raw: unknown;
}

function pick<T = any>(o: any, path: (string | number)[]): T | null {
  let cur: any = o;
  for (const k of path) {
    if (cur == null) return null;
    cur = cur[k as any];
  }
  return (cur ?? null) as T | null;
}

function parseComment(node: any, postId: string): ParsedComment | null {
  const cid = node?.legacy_fbid ? String(node.legacy_fbid) : null;
  if (!cid) return null;
  const reactionCount =
    pick<number>(node, ['feedback', 'reaction_count', 'count']) ??
    pick<number>(node, ['feedback', 'unified_reactors', 'count']) ??
    pick<number>(node, ['feedback', 'reactors', 'count']) ??
    null;
  return {
    comment_id: cid,
    post_id: postId,
    parent_comment_id: null, // depth-0 root list; replies handled via raw for now
    author_id: pick<string>(node, ['author', 'id']),
    message: pick<string>(node, ['body', 'text']),
    created_time: node.created_time ? new Date(Number(node.created_time) * 1000) : null,
    reaction_count: reactionCount,
    raw: node,
  };
}

/** Comments live at data.node.comment_rendering_instance_for_feed_location.comments */
function walkComments(payloads: any[], postId: string): { comments: ParsedComment[]; nextCursor: string | null; hasNext: boolean } {
  const comments: ParsedComment[] = [];
  let nextCursor: string | null = null;
  let hasNext = false;

  for (const p of payloads) {
    const ci =
      pick<any>(p, ['data', 'node', 'comment_rendering_instance_for_feed_location', 'comments']) ??
      pick<any>(p, ['data', 'feedback', 'comment_rendering_instance_for_feed_location', 'comments']);
    if (!ci) continue;
    for (const edge of ci.edges ?? []) {
      const parsed = parseComment(edge?.node, postId);
      if (parsed) comments.push(parsed);
    }
    const pi = ci.page_info ?? {};
    if (pi.end_cursor) nextCursor = String(pi.end_cursor);
    if (pi.has_next_page === true) hasNext = true;
    if (pi.has_next_page === false) hasNext = false;
  }
  return { comments, nextCursor, hasNext };
}

async function listPostsForGroup(groupId: string, limit: number): Promise<Array<{ post_id: string; feedback_id: string; comment_count: number; scraped_count: number }>> {
  const { rows } = await pool.query(
    `SELECT p.post_id,
            (p.raw->'feedback'->>'id')                        AS feedback_id,
            COALESCE(p.comment_count, 0)                      AS comment_count,
            COALESCE(c.n, 0)                                  AS scraped_count
       FROM fact_group_post p
       LEFT JOIN (
         SELECT post_id, count(*)::int AS n
           FROM fact_group_post_comment
          WHERE deleted_at IS NULL
          GROUP BY post_id
       ) c USING (post_id)
      WHERE p.group_id = $1
        AND p.deleted_at IS NULL
        AND COALESCE(p.comment_count, 0) > 0
        AND (p.raw->'feedback'->>'id') IS NOT NULL
        -- prioritise posts with new comments not yet scraped
        AND (COALESCE(c.n, 0) < COALESCE(p.comment_count, 0))
      ORDER BY (COALESCE(p.comment_count, 0) - COALESCE(c.n, 0)) DESC,
               p.comment_count DESC
      LIMIT $2`,
    [groupId, limit]
  );
  return rows;
}

export const fb_group_post_comment: EntityConfig = {
  name: 'fb_group_post_comment',
  module: 'group',
  async run({ client, scope, mode }): Promise<EntityRunResult> {
    const groupId = scope;
    const limit = mode === 'full' ? MAX_POSTS_PER_RUN_FULL : MAX_POSTS_PER_RUN_INCR;
    const posts = await listPostsForGroup(groupId, limit);

    let pages_scanned = 0;
    let rows_seen = 0;
    let rows_upserted = 0;

    for (const post of posts) {
      // ROOT query alone with commentsAfterCount=-1 = "load all". Variables
      // mirror the captured sample exactly; any extra/missing var triggers
      // "missing_required_variable_value" from FB.
      const variables: Record<string, unknown> = {
        commentsAfterCount: -1,
        commentsAfterCursor: null,
        commentsBeforeCount: null,
        commentsBeforeCursor: null,
        commentsIntentToken: null,
        feedLocation: 'POST_PERMALINK_DIALOG',
        focusCommentID: null,
        scale: 1,
        useDefaultActor: false,
        id: post.feedback_id,
        ...RELAY_PROVIDERS,
      };
      const res = await client.graphql({ friendlyName: FN_ROOT, docId: DOC_ROOT, variables });
      pages_scanned++;
      const { comments } = walkComments(res.payloads, post.post_id);
      rows_seen += comments.length;
      if (comments.length === 0) continue;

      rows_upserted += await upsertBatch({
        table: 'fact_group_post_comment',
        keyCols: ['tenant_id', 'comment_id'],
        rows: comments.map((c) => ({
          comment_id: c.comment_id,
          post_id: c.post_id,
          parent_comment_id: c.parent_comment_id,
          author_id: c.author_id,
          message: c.message,
          created_time: c.created_time,
          reaction_count: c.reaction_count,
          raw: c.raw,
          synced_at: new Date(),
        })),
      });
    }

    return { entity: 'fb_group_post_comment', scope, pages_scanned, rows_seen, rows_upserted };
  },
};
