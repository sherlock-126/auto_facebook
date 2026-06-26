/**
 * Agent port of cloud's fb_group_post entity.
 *
 * Crawls posts from one group, uploads to cloud /api/agent/upload (entity=posts).
 * Cloud-side fires lead detection on each upload. Watermark lives locally in
 * /var/lib/auto-facebook-agent/state.json (via state.ts).
 */
import { uploadBatch } from '../../upload.js';
import { readWatermark, writeWatermark } from '../../state.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

const DOC_ID        = '26709925515346593';
const FRIENDLY_NAME = 'GroupsCometFeedRegularStoriesPaginationQuery';
const PAGE_SIZE     = 30;

const RELAY_PROVIDERS: Record<string, unknown> = {
  __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
  __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
  __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider: false,
  __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider: false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
  __relay_internal__pv__IsWorkUserrelayprovider: false,
  __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
  __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
  __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
  __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider: false,
  __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
  __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
  __relay_internal__pv__IsMergQAPollsrelayprovider: false,
  __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
  __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
  __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
  __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
  __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider: true,
  __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
  __relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider: false,
  __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider: true,
  __relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider: 206,
  __relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider: true,
  __relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider: false,
};

function buildVariables(groupId: string, cursor: string | null): Record<string, unknown> {
  return {
    count: PAGE_SIZE,
    cursor,
    feedLocation: 'GROUP',
    feedType: 'DISCUSSION',
    feedbackSource: 0,
    filterTopicId: null,
    focusCommentID: null,
    privacySelectorRenderLocation: 'COMET_STREAM',
    referringStoryRenderLocation: null,
    renderLocation: 'group',
    scale: 1,
    sortingSetting: 'CHRONOLOGICAL',
    stream_initial_count: 1,
    useDefaultActor: false,
    id: groupId,
    ...RELAY_PROVIDERS,
  };
}

interface ParsedPost {
  post_id:           string;
  group_id:          string;
  author_id:         string | null;
  permalink:         string | null;
  message:           string | null;
  story_type:        string | null;
  created_time:      Date | null;
  attachment_url:    string | null;
  reaction_count:    number | null;
  comment_count:     number | null;
  share_count:       number | null;
  is_anonymous_post: boolean;
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

function findRenderer(node: any, type: string): any {
  const renderers = pick<any[]>(node, [
    'comet_sections', 'feedback', 'story', 'story_ufi_container', 'story',
    'feedback_context', 'feedback_target_with_context',
    'comet_ufi_summary_and_actions_renderer', 'feedback',
    'adaptive_ufi_action_renderers',
  ]) ?? [];
  for (const r of renderers) {
    if (r?.__typename === type || r?.feedback?.__typename === type) return r;
    if (type === 'reactionCount' && r?.feedback?.reaction_count?.count != null) return r;
    if (type === 'commentCount' && r?.feedback?.comment_rendering_instance?.comments?.total_count != null) return r;
    if (type === 'shareCount'   && r?.feedback?.share_count?.count != null) return r;
  }
  return null;
}

function parsePost(node: any, groupId: string): ParsedPost | null {
  const postId = node?.post_id ? String(node.post_id) : null;
  if (!postId) return null;
  const reactionRenderer = findRenderer(node, 'reactionCount');
  const commentRenderer  = findRenderer(node, 'commentCount');
  const shareRenderer    = findRenderer(node, 'shareCount');
  const reactionCount = pick<number>(reactionRenderer, ['feedback', 'reaction_count', 'count']);
  const commentCount  = pick<number>(commentRenderer,  ['feedback', 'comment_rendering_instance', 'comments', 'total_count'])
                     ?? pick<number>(node, ['comet_sections','feedback','story','story_ufi_container','story','feedback_context','feedback_target_with_context','comment_rendering_instance','comments','total_count']);
  const shareCount    = pick<number>(shareRenderer, ['feedback', 'share_count', 'count']);
  const message = pick<string>(node, ['comet_sections','content','story','message','text'])
              ?? pick<string>(node, ['comet_sections','content','story','comet_sections','message','story','message','text']);
  const createdUnix = pick<number>(node, ['comet_sections','timestamp','story','creation_time'])
                  ?? pick<number>(node, ['comet_sections','context_layout','story','comet_sections','metadata',0,'story','creation_time']);
  const author = pick<any>(node, ['actors', 0]) ?? pick<any>(node, ['comet_sections','content','story','actors', 0]);

  // Anonymous detection: FB returns one of these shapes for anonymous group posts:
  //   - node.is_anonymous_post === true
  //   - actors[0].__typename === 'GroupAnonymousAuthor' or 'GroupAnonAuthorProfile'
  //     (FB has used both names; the latter is the current 2026 shape)
  //   - actors[0].__isActor === 'GroupAnonAuthorProfile'
  //   - actor present but missing valid `id` or has `url: null` (rare fallback)
  // Sale UX: anonymous → can't IB (no Messenger profile) → must comment publicly.
  const authorTypename = pick<string>(node, ['actors', 0, '__typename']);
  const authorIsActor  = pick<string>(node, ['actors', 0, '__isActor']);
  const authorUrl      = pick<string>(node, ['actors', 0, 'url']);
  const isAnonymous =
    node?.is_anonymous_post === true ||
    authorTypename === 'GroupAnonymousAuthor' ||
    authorTypename === 'GroupAnonAuthorProfile' ||
    authorIsActor  === 'GroupAnonAuthorProfile' ||
    (!!author && !author.id) ||
    (!!author && author.id && !authorUrl);  // anon profiles have id but url:null
  const attachment = pick<any>(node, ['attachments', 0]);
  const attachmentUrl = pick<string>(attachment, ['url'])
                    ?? pick<string>(attachment, ['target', 'url'])
                    ?? pick<string>(attachment, ['media', 'image', 'uri']);
  const storyType = pick<string>(attachment, ['styles', 'attachment', '__typename'])
                ?? pick<string>(attachment, ['__typename'])
                ?? (message ? 'TEXT' : null);

  return {
    post_id: postId,
    group_id: groupId,
    author_id: author?.id ? String(author.id) : null,
    permalink: pick<string>(node, ['permalink_url']),
    message,
    story_type: storyType,
    created_time: createdUnix ? new Date(createdUnix * 1000) : null,
    attachment_url: attachmentUrl,
    reaction_count:    reactionCount,
    comment_count:     commentCount,
    share_count:       shareCount,
    is_anonymous_post: isAnonymous,
    raw: node,
  };
}

function walkPosts(payloads: any[], groupId: string): { posts: ParsedPost[]; nextCursor: string | null } {
  const posts: ParsedPost[] = [];
  let nextCursor: string | null = null;
  const pushEdge = (edge: any) => {
    const parsed = parsePost(edge?.node, groupId);
    if (parsed) posts.push(parsed);
    if (edge?.cursor) nextCursor = String(edge.cursor);
  };
  for (const p of payloads) {
    const d = p?.data;
    if (!d) continue;
    const path: any[] = Array.isArray(p?.path) ? p.path : [];
    const isEdgesStream    = path.length === 4 && path[0] === 'node' && path[1] === 'group_feed' && path[2] === 'edges';
    const isPageInfoDefer  = path.length === 2 && path[0] === 'node' && path[1] === 'group_feed';
    if (isEdgesStream) { pushEdge(d); continue; }
    if (isPageInfoDefer) {
      const pi = d?.page_info;
      if (pi?.end_cursor) nextCursor = String(pi.end_cursor);
      if (pi?.has_next_page === false) nextCursor = null;
      continue;
    }
    const feed = d?.node?.group_feed;
    if (!feed) continue;
    for (const edge of feed.edges ?? []) pushEdge(edge);
    if (feed.page_info?.end_cursor) nextCursor = String(feed.page_info.end_cursor);
    if (feed.page_info?.has_next_page === false) nextCursor = null;
  }
  return { posts, nextCursor };
}

export const fb_group_post: EntityConfig = {
  name:   'fb_group_post',
  module: 'group',
  async run({ client, cfg, scope, mode }): Promise<EntityRunResult> {
    const entity  = 'fb_group_post';
    const groupId = scope;
    const wm    = readWatermark(entity, scope);
    const since = wm ? new Date(wm.getTime() - 5 * 60_000) : null;

    let cursor: string | null = null;
    let pages_scanned = 0;
    let rows_seen = 0;
    let rows_upserted = 0;
    let newWatermark: Date | null = wm;
    // incr (every 15min / "Run crawl now") = SHALLOW: just the newest posts, so a
    // big group can't blow the per-entity timeout walking 60 pages at the safe
    // 10-25s/request pacing (first crawl has no watermark to stop early). The
    // nightly `full` sweep walks deep. 6 pages × ~20 posts = newest ~120 posts.
    const MAX_PAGES = mode === 'incr' ? 6 : 60;

    while (pages_scanned < MAX_PAGES) {
      const res = await client.graphql({
        friendlyName: FRIENDLY_NAME,
        docId: DOC_ID,
        variables: buildVariables(groupId, cursor),
      });
      pages_scanned++;
      const { posts, nextCursor } = walkPosts(res.payloads, groupId);
      rows_seen += posts.length;
      if (posts.length === 0) break;

      rows_upserted += await uploadBatch(cfg, 'posts', posts.map((p) => ({
        post_id:           p.post_id,
        group_id:          p.group_id,
        author_id:         p.author_id,
        permalink:         p.permalink,
        message:           p.message,
        story_type:        p.story_type,
        created_time:      p.created_time?.toISOString() ?? null,
        attachment_url:    p.attachment_url,
        reaction_count:    p.reaction_count,
        comment_count:     p.comment_count,
        share_count:       p.share_count,
        is_anonymous_post: p.is_anonymous_post,
        raw:               p.raw,
        synced_at:         new Date().toISOString(),
      })));

      for (const p of posts) {
        if (p.created_time && (!newWatermark || p.created_time > newWatermark)) {
          newWatermark = p.created_time;
        }
      }

      // CHECKPOINT after each page — survives timeout/crash mid-loop. Without
      // this, a sweep that hits the runner's per-entity timeout discards ALL
      // progress + replays the same pages next sweep → infinite stuck loop
      // when backlog can't be cleared within timeout (saw this on heavy POD
      // groups after state.json revert via backup restore, 2026-06-02).
      if (newWatermark) {
        writeWatermark({ entity, scope, cursor: newWatermark, status: 'ok', count: rows_upserted });
      }

      if (mode === 'incr' && since) {
        const anyNewer = posts.some((p) => !p.created_time || p.created_time > since);
        if (!anyNewer) break;
      }

      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    // Final write redundant (loop wrote per page) but harmless + keeps semantic.
    if (newWatermark) {
      writeWatermark({ entity, scope, cursor: newWatermark, status: 'ok', count: rows_upserted });
    }
    return { entity, scope, pages_scanned, rows_seen, rows_upserted, new_watermark: newWatermark?.toISOString() };
  },
};
