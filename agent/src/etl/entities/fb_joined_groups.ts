/**
 * Agent port of cloud's fb_joined_groups entity.
 *
 * Discovers groups the logged-in user has joined and uploads to cloud's
 * /api/agent/upload (entity=groups). Cloud-side UPSERTs into dim_group with
 * tenant_id from license_key.
 */
import { uploadBatch } from '../../upload.js';
import { log } from '../../log.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

const DOC_ID        = '9974006939348139';
const FRIENDLY_NAME = 'GroupsCometAllJoinedGroupsSectionPaginationQuery';

interface ParsedGroup {
  group_id: string;
  name:     string | null;
  url:      string | null;
  raw:      unknown;
}

function walkGroups(payloads: any[]): { groups: ParsedGroup[]; nextCursor: string | null } {
  const groups: ParsedGroup[] = [];
  let nextCursor: string | null = null;
  for (const p of payloads) {
    const list = p?.data?.viewer?.all_joined_groups?.tab_groups_list;
    if (!list) continue;
    for (const edge of list.edges ?? []) {
      const node = edge?.node;
      if (!node?.id) continue;
      if (node.viewer_join_state && node.viewer_join_state !== 'MEMBER') continue;
      groups.push({
        group_id: String(node.id),
        name:     node.name ?? null,
        url:      node.url ?? null,
        raw:      node,
      });
    }
    if (list.page_info?.has_next_page && list.page_info?.end_cursor) {
      nextCursor = String(list.page_info.end_cursor);
    } else if (list.page_info?.has_next_page === false) {
      nextCursor = null;
    }
  }
  return { groups, nextCursor };
}

export const fb_joined_groups: EntityConfig = {
  name:   'fb_joined_groups',
  module: 'group',
  async run({ client, cfg, scope, mode }): Promise<EntityRunResult> {
    let cursor: string | null = null;
    let rows_seen = 0;
    let pages_scanned = 0;
    let dupeStreak = 0;
    const seenIds = new Set<string>();
    const collected: Record<string, unknown>[] = [];
    // incr runs every ~15min — keep it shallow (just catch groups joined recently,
    // which surface near the top). The manual "Refresh groups list" (discover) and
    // the nightly full sweep walk deep enough to enumerate the whole membership
    // (166+ groups → ~9 pages at 20/page; allow generous headroom).
    const MAX_PAGES = mode === 'incr' ? 3 : 40;
    // The `integrity_signals` ordering is RANKED, not a stable list, so it re-emits
    // already-seen groups on later pages. A single all-duplicate page is NOT the end
    // of the list — only give up after several consecutive dupe pages (or no cursor).
    const MAX_DUPE_STREAK = 3;

    while (pages_scanned < MAX_PAGES) {
      const variables: Record<string, unknown> = {
        count: 20,
        cursor,
        ordering: ['integrity_signals'],
        scale: 1,
      };
      const res = await client.graphql({ friendlyName: FRIENDLY_NAME, docId: DOC_ID, variables });
      pages_scanned++;

      const { groups, nextCursor } = walkGroups(res.payloads);
      rows_seen += groups.length;
      if (groups.length === 0) break;

      const newOnPage = groups.filter((g) => !seenIds.has(g.group_id));
      for (const g of groups) seenIds.add(g.group_id);

      if (newOnPage.length === 0) {
        dupeStreak++;
        log('warn', `fb_joined_groups page ${pages_scanned}: all ${groups.length} already seen (dupe streak ${dupeStreak}/${MAX_DUPE_STREAK})`);
        if (dupeStreak >= MAX_DUPE_STREAK || !nextCursor) break;
        cursor = nextCursor;
        continue;
      }
      dupeStreak = 0;

      for (const g of newOnPage) collected.push({
        group_id:   g.group_id,
        name:       g.name,
        url:        g.url,
        is_joined:  true,
        enabled:    false, // user must opt-in via UI to avoid blowing budget
        raw:        g.raw,
        updated_at: new Date().toISOString(),
      });

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    // Upload ONCE at the end: a single page's transient 502 must not truncate the
    // whole walk (the old per-page upload aborted discovery on the first failure).
    let rows_upserted = 0;
    if (collected.length) rows_upserted = await uploadBatch(cfg, 'groups', collected);
    log('info', `fb_joined_groups done: pages=${pages_scanned} seen=${rows_seen} unique=${seenIds.size} uploaded=${rows_upserted}`);

    return { entity: 'fb_joined_groups', scope, pages_scanned, rows_seen, rows_upserted };
  },
};
