import type { FbClient } from '../fb/client.js';
import type { AgentConfig } from '../config.js';

export interface EntityRunResult {
  entity:         string;
  scope:          string;
  pages_scanned:  number;
  rows_seen:      number;
  rows_upserted:  number;
  new_watermark?: string;
}

export interface EntityRunContext {
  client: FbClient;
  cfg:    AgentConfig;
  scope:  string;
  mode:   'incr' | 'full';
}

export interface EntityConfig {
  name:   string;
  module: string;
  run(args: EntityRunContext): Promise<EntityRunResult>;
}

import { fb_joined_groups } from './entities/fb_joined_groups.js';
import { fb_group_post } from './entities/fb_group_post.js';
import { fb_group_post_comment } from './entities/fb_group_post_comment.js';

export const ENTITIES: EntityConfig[] = [fb_joined_groups, fb_group_post, fb_group_post_comment];

export function findEntity(name: string): EntityConfig | undefined {
  return ENTITIES.find((e) => e.name === name);
}
