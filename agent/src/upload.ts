/**
 * HTTP client: agent → cloud uploads + helper-endpoint reads.
 *
 * Retries 3× with exponential backoff on 5xx / network. 4xx fails loudly so
 * the caller knows their payload is malformed.
 */
import { AGENT_VERSION } from './version.js';
import { log } from './log.js';
import type { AgentConfig } from './config.js';

const UA = `auto-facebook-agent/${AGENT_VERSION}`;

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function authedFetch(
  cfg: AgentConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${cfg.cloud_url}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'authorization': `Bearer ${cfg.license_key}`,
        'user-agent':    UA,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export type UploadEntity = 'groups' | 'posts' | 'comments' | 'run';

export async function uploadBatch(
  cfg: AgentConfig,
  entity: UploadEntity,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const body = JSON.stringify({ entity, rows });
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await authedFetch(cfg, '/api/agent/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (res.ok) {
        const j: any = await res.json().catch(() => ({}));
        return Number(j?.upserted ?? j?.inserted ?? rows.length);
      }
      const errText = await res.text().catch(() => '');
      if (res.status >= 400 && res.status < 500) {
        // Client error — bail immediately.
        throw new Error(`upload ${entity} ${res.status}: ${errText.slice(0, 300)}`);
      }
      lastErr = new Error(`upload ${entity} ${res.status}: ${errText.slice(0, 300)}`);
    } catch (e: any) {
      lastErr = e;
    }
    if (attempt < 3) {
      const backoff = 500 * Math.pow(2, attempt - 1);
      log('warn', `upload retry ${attempt}`, { entity, err: lastErr?.message, sleep_ms: backoff });
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error(`upload ${entity} failed after retries`);
}

export async function fetchGroupsToCrawl(cfg: AgentConfig): Promise<string[]> {
  const res = await authedFetch(cfg, '/api/agent/groups-to-crawl', { method: 'GET' });
  if (!res.ok) throw new Error(`groups-to-crawl ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  return (j?.rows ?? []).map((r: any) => String(r.group_id));
}

export interface PostForCommentCrawl {
  post_id:        string;
  feedback_id:    string;
  comment_count:  number;
  scraped_count:  number;
}

export async function fetchPostsForComments(
  cfg: AgentConfig,
  groupId: string,
  limit: number,
): Promise<PostForCommentCrawl[]> {
  const url = `/api/agent/posts-for-comments?group_id=${encodeURIComponent(groupId)}&limit=${limit}`;
  const res = await authedFetch(cfg, url, { method: 'GET' });
  if (!res.ok) throw new Error(`posts-for-comments ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  return j?.rows ?? [];
}
