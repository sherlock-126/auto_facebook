/**
 * Agent port of cloud's fb_group_post_comment entity.
 *
 * Per-post comment crawler. Instead of querying local DB for which posts need
 * comment-crawling (cloud's listPostsForGroup), the agent calls the cloud's
 * /api/agent/posts-for-comments helper, which does the same prioritization
 * (posts where actual comment_count > our scraped_count).
 */
import { uploadBatch, fetchPostsForComments } from '../../upload.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

const DOC_ROOT       = '26692082413774551';
const FN_ROOT        = 'CommentListComponentsRootQuery';

const RELAY_PROVIDERS: Record<string, unknown> = {
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
  __relay_internal__pv__IsWorkUserrelayprovider: false,
};

const MAX_POSTS_PER_RUN_INCR = 40;
const MAX_POSTS_PER_RUN_FULL = 200;

interface ParsedComment {
  comment_id:        string;
  post_id:           string;
  parent_comment_id: string | null;
  author_id:         string | null;
  message:           string | null;
  created_time:      Date | null;
  reaction_count:    number | null;
  raw:               unknown;
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
    parent_comment_id: null,
    author_id: pick<string>(node, ['author', 'id']),
    message:   pick<string>(node, ['body', 'text']),
    created_time: node.created_time ? new Date(Number(node.created_time) * 1000) : null,
    reaction_count: reactionCount,
    raw: node,
  };
}

function walkComments(payloads: any[], postId: string): { comments: ParsedComment[]; nextCursor: string | null; hasNext: boolean } {
  const comments: ParsedComment[] = [];
  let nextCursor: string | null = null;
  let hasNext = false;
  for (const p of payloads) {
    const ci =
      pick<any>(p, ['data', 'node',     'comment_rendering_instance_for_feed_location', 'comments']) ??
      pick<any>(p, ['data', 'feedback', 'comment_rendering_instance_for_feed_location', 'comments']);
    if (!ci) continue;
    for (const edge of ci.edges ?? []) {
      const parsed = parseComment(edge?.node, postId);
      if (parsed) comments.push(parsed);
    }
    const pi = ci.page_info ?? {};
    if (pi.end_cursor) nextCursor = String(pi.end_cursor);
    if (pi.has_next_page === true)  hasNext = true;
    if (pi.has_next_page === false) hasNext = false;
  }
  return { comments, nextCursor, hasNext };
}

export const fb_group_post_comment: EntityConfig = {
  name:   'fb_group_post_comment',
  module: 'group',
  async run({ client, cfg, scope, mode }): Promise<EntityRunResult> {
    const groupId = scope;
    const limit   = mode === 'full' ? MAX_POSTS_PER_RUN_FULL : MAX_POSTS_PER_RUN_INCR;
    const posts   = await fetchPostsForComments(cfg, groupId, limit);

    let pages_scanned = 0;
    let rows_seen = 0;
    let rows_upserted = 0;

    for (const post of posts) {
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

      rows_upserted += await uploadBatch(cfg, 'comments', comments.map((c) => ({
        comment_id:        c.comment_id,
        post_id:           c.post_id,
        parent_comment_id: c.parent_comment_id,
        author_id:         c.author_id,
        message:           c.message,
        created_time:      c.created_time?.toISOString() ?? null,
        reaction_count:    c.reaction_count,
        raw:               c.raw,
        synced_at:         new Date().toISOString(),
      })));
    }

    return { entity: 'fb_group_post_comment', scope, pages_scanned, rows_seen, rows_upserted };
  },
};
