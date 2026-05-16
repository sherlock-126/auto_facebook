/**
 * Entity: fb_group_post
 *
 * Scrape posts from a single group (scope = group_id).
 *
 * STATUS: skeleton — needs discovered endpoint wired in.
 *
 * HOW TO FILL IN:
 *   1. Run discover mode + open the target group in noVNC.
 *   2. Scroll the feed a few times to trigger pagination.
 *   3. `GET /api/discover/captures` — look for friendly_name like
 *      `GroupsCometFeedRegularStoriesPaginationQuery` or
 *      `GroupsCometFeedRegularStoriesQuery` (initial vs paginated).
 *   4. Inspect a sample payload. Find:
 *        - edges array of stories
 *        - story.id / story.post_id / story.legacy_token
 *        - story.creation_time (unix seconds)
 *        - story.message.text
 *        - story.feedback.reactors.count / .comments.total_count / .share_count
 *        - story.actors[0].id (author)
 *        - story.url (permalink)
 *      and page_info.end_cursor.
 *   5. Fill in DOC_ID, FRIENDLY_NAME, VARIABLES_TEMPLATE, walkPosts().
 */
import { upsertBatch } from '../upsert.js';
import { readWatermark, writeWatermark } from '../watermark.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

// ===== TODO: fill from discover =====
const DOC_ID: string | null = null;
const FRIENDLY_NAME = 'TODO_GroupsFeedQuery';
const VARIABLES_TEMPLATE = (groupId: string, cursor?: string) => ({
  id: groupId,
  count: 10,
  cursor: cursor ?? null,
  feedLocation: 'GROUP',
  scale: 1,
});
// =====================================

interface ParsedPost {
  post_id: string;
  group_id: string;
  author_id: string | null;
  permalink: string | null;
  message: string | null;
  story_type: string | null;
  created_time: Date | null;
  attachment_url: string | null;
  reaction_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  raw: unknown;
}

function walkPosts(payloads: any[], groupId: string): { posts: ParsedPost[]; nextCursor: string | null } {
  // TODO: implement after inspecting real payload.
  const posts: ParsedPost[] = [];
  let nextCursor: string | null = null;
  for (const _p of payloads) {
    // walk p.data.node.group_feed.edges[].node etc.
  }
  return { posts, nextCursor };
}

export const fb_group_post: EntityConfig = {
  name: 'fb_group_post',
  module: 'group',
  async run({ client, scope, mode }): Promise<EntityRunResult> {
    if (!DOC_ID && FRIENDLY_NAME.startsWith('TODO_')) {
      throw new Error(
        'fb_group_post not yet wired: run discover mode and fill DOC_ID / FRIENDLY_NAME / walkPosts()'
      );
    }
    const entity = 'fb_group_post';
    const groupId = scope;
    const wm = await readWatermark(entity, scope);
    const since = wm ? new Date(wm.getTime() - 5 * 60_000) : null; // 5-min overlap (§8)

    let cursor: string | undefined;
    let pages_scanned = 0;
    let rows_seen = 0;
    let rows_upserted = 0;
    let newWatermark: Date | null = wm;
    const MAX_PAGES = mode === 'full' ? 30 : 3;

    while (pages_scanned < MAX_PAGES) {
      const res = await client.graphql({
        friendlyName: FRIENDLY_NAME,
        docId: DOC_ID ?? undefined,
        variables: VARIABLES_TEMPLATE(groupId, cursor),
      });
      pages_scanned++;
      const { posts, nextCursor } = walkPosts(res.payloads, groupId);
      rows_seen += posts.length;
      if (posts.length === 0) break;

      // Stop early in incr mode once we hit older content
      if (mode === 'incr' && since) {
        const anyNewer = posts.some((p) => !p.created_time || p.created_time > since);
        if (!anyNewer) break;
      }
      const fresh = mode === 'incr' && since
        ? posts.filter((p) => !p.created_time || p.created_time > since)
        : posts;

      rows_upserted += await upsertBatch({
        table: 'fact_group_post',
        keyCols: ['post_id'],
        rows: fresh.map((p) => ({
          post_id: p.post_id,
          group_id: p.group_id,
          author_id: p.author_id,
          permalink: p.permalink,
          message: p.message,
          story_type: p.story_type,
          created_time: p.created_time,
          attachment_url: p.attachment_url,
          reaction_count: p.reaction_count,
          comment_count: p.comment_count,
          share_count: p.share_count,
          raw: p.raw,
          synced_at: new Date(),
        })),
      });

      for (const p of fresh) {
        if (p.created_time && (!newWatermark || p.created_time > newWatermark)) {
          newWatermark = p.created_time;
        }
      }

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    if (newWatermark) {
      await writeWatermark({ entity, scope, cursor: newWatermark, status: 'ok', count: rows_upserted });
    }
    return { entity, scope, pages_scanned, rows_seen, rows_upserted, new_watermark: newWatermark?.toISOString() };
  },
};
