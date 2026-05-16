/**
 * Entity: fb_joined_groups
 *
 * Discover groups the logged-in user has joined and upsert into `dim_group`.
 *
 * STATUS: skeleton — needs discovered endpoint wired in.
 *
 * HOW TO FILL IN:
 *   1. Run discover mode (server: POST /api/discover/start).
 *   2. Via noVNC, browse to https://www.facebook.com/groups/feed/ or
 *      https://www.facebook.com/groups/joins/.
 *   3. `GET /api/discover/captures` — look for an entry with friendly_name
 *      matching something like `GroupsCometTabBarYouQuery` /
 *      `GroupsTabBarYouQuery` / `CometGroupsTabRootQuery`.
 *      (Exact name changes; that's why we don't hard-code blindly.)
 *   4. Inspect the response payload via `GET /api/discover/captures/:id`.
 *      Find the list of joined groups inside the JSON.
 *   5. Fill in DOC_ID, FRIENDLY_NAME, VARIABLES_TEMPLATE, and the
 *      walkGroups() function below.
 *   6. Test: `tsx src/cli.ts run fb_joined_groups global incr`.
 */
import { upsertBatch } from '../upsert.js';
import type { EntityConfig, EntityRunResult } from '../entity_registry.js';

// ===== TODO: fill from discover =====
const DOC_ID: string | null = null;                   // e.g. '987654321'
const FRIENDLY_NAME = 'TODO_GroupsTabYouQuery';
const VARIABLES_TEMPLATE = (cursor?: string) => ({
  count: 20,
  cursor: cursor ?? null,
  scale: 1,
});
// =====================================

interface ParsedGroup {
  group_id: string;
  name: string | null;
  url: string | null;
  privacy: string | null;
  member_count: number | null;
  raw: unknown;
}

function walkGroups(payloads: any[]): { groups: ParsedGroup[]; nextCursor: string | null } {
  // TODO: navigate FB's deeply nested GraphQL response.
  // Typical path is something like:
  //   data.viewer.groups_tab.tab_groups.edges[].node
  //   - node.id (or node.fbid)
  //   - node.name
  //   - node.url
  //   - node.privacy_info.value
  //   - node.member_count or node.group_member_total
  // and page_info.has_next_page + page_info.end_cursor
  const groups: ParsedGroup[] = [];
  let nextCursor: string | null = null;
  for (const _p of payloads) {
    // implement after inspecting a real payload
  }
  return { groups, nextCursor };
}

export const fb_joined_groups: EntityConfig = {
  name: 'fb_joined_groups',
  module: 'group',
  async run({ client, scope, mode }): Promise<EntityRunResult> {
    if (!DOC_ID && FRIENDLY_NAME.startsWith('TODO_')) {
      throw new Error(
        'fb_joined_groups not yet wired: run discover mode and fill DOC_ID / FRIENDLY_NAME / walkGroups()'
      );
    }
    let cursor: string | undefined;
    let rows_seen = 0;
    let rows_upserted = 0;
    let pages_scanned = 0;
    const MAX_PAGES = mode === 'full' ? 20 : 3;

    while (pages_scanned < MAX_PAGES) {
      const res = await client.graphql({
        friendlyName: FRIENDLY_NAME,
        docId: DOC_ID ?? undefined,
        variables: VARIABLES_TEMPLATE(cursor),
      });
      pages_scanned++;
      const { groups, nextCursor } = walkGroups(res.payloads);
      rows_seen += groups.length;
      if (groups.length === 0) break;

      rows_upserted += await upsertBatch({
        table: 'dim_group',
        keyCols: ['group_id'],
        rows: groups.map((g) => ({
          group_id: g.group_id,
          name: g.name,
          url: g.url,
          privacy: g.privacy,
          member_count: g.member_count,
          is_joined: true,
          raw: g.raw,
          updated_at: new Date(),
        })),
        updateCols: ['name', 'url', 'privacy', 'member_count', 'is_joined', 'raw', 'updated_at'],
      });

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    return { entity: 'fb_joined_groups', scope, pages_scanned, rows_seen, rows_upserted };
  },
};
