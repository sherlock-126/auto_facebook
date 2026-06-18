/**
 * Entity: fb_joined_groups
 *
 * Discover groups the logged-in user has joined and upsert into `dim_group`.
 *
 * Endpoint wired from discover capture 2026-05-18:
 *   friendly_name: GroupsCometAllJoinedGroupsSectionPaginationQuery
 *   doc_id:        9974006939348139
 *   variables:     { count: 20, cursor, ordering: ['integrity_signals'], scale: 1 }
 *   response path: data.viewer.all_joined_groups.tab_groups_list.edges[].node
 *
 * First page passes cursor=null. Subsequent pages forward page_info.end_cursor.
 * Note: the alternative friendly_name `GroupsCometJoinsRootQuery` returns the
 * same shape but with `viewer_added` ordering; cursors are not interchangeable
 * between orderings, so we stick to one query for the whole walk.
 */
import { upsertBatch } from '../upsert.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

const DOC_ID = '9974006939348139';
const FRIENDLY_NAME = 'GroupsCometAllJoinedGroupsSectionPaginationQuery';

interface ParsedGroup {
  group_id: string;
  name: string | null;
  url: string | null;
  raw: unknown;
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
        name: node.name ?? null,
        url: node.url ?? null,
        raw: node,
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
  name: 'fb_joined_groups',
  module: 'group',
  async run({ client, scope, mode }): Promise<EntityRunResult> {
    let cursor: string | null = null;
    let rows_seen = 0;
    let rows_upserted = 0;
    let pages_scanned = 0;
    const seenIds = new Set<string>();
    // Account-bound list — a few hundred at most. Allow up to 30 pages
    // (~600 groups) in full mode, 15 (~300) in incr.
    const MAX_PAGES = mode === 'full' ? 30 : 15;

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
        console.warn(`[fb_joined_groups] page ${pages_scanned} returned only seen group_ids — stopping`);
        break;
      }

      rows_upserted += await upsertBatch({
        table: 'dim_group',
        keyCols: ['tenant_id', 'group_id'],
        // enabled=false on first insert — user must opt-in per group via UI to
        // avoid blowing the 400 req/day budget on irrelevant groups.
        // updateCols intentionally omits `enabled` so user toggles persist.
        rows: newOnPage.map((g) => ({
          group_id: g.group_id,
          name: g.name,
          url: g.url,
          is_joined: true,
          enabled: false,
          raw: g.raw,
          updated_at: new Date(),
        })),
        updateCols: ['name', 'url', 'is_joined', 'raw', 'updated_at'],
      });

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    return { entity: 'fb_joined_groups', scope, pages_scanned, rows_seen, rows_upserted };
  },
};
