import type { FbClient } from '../fb/client.js';

export interface EntityRunResult {
  entity: string;
  scope: string;
  pages_scanned: number;
  rows_seen: number;
  rows_upserted: number;
  new_watermark?: string;
}

export interface EntityConfig {
  /** Unique name, e.g. 'fb_group_post' */
  name: string;
  /** Group, e.g. 'group' */
  module: string;
  /** Run the entity for one scope (group_id, or 'global' for discovery entities). */
  run(args: { client: FbClient; scope: string; mode: 'incr' | 'full'; tenantId: string }): Promise<EntityRunResult>;
}

import { fb_joined_groups } from './entities/fb_joined_groups.js';
import { fb_group_post } from './entities/fb_group_post.js';
import { fb_group_post_comment } from './entities/fb_group_post_comment.js';

export const ENTITIES: EntityConfig[] = [fb_joined_groups, fb_group_post, fb_group_post_comment];

export function findEntity(name: string): EntityConfig | undefined {
  return ENTITIES.find((e) => e.name === name);
}
