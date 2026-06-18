/**
 * Lead pipeline domain types: intent enum, stage enum, tenant config helper.
 */
import { pool } from '../db.js';

export const INTENT_VALUES = [
  'request_quote',
  'question',
  'complaint',
  'showcase',
  'spam',
  'seeding',
  'other',
] as const;
export type Intent = (typeof INTENT_VALUES)[number];

export const STAGE_VALUES = [
  'new',
  'contacted',
  'info_sent',
  'negotiating',
  'sample_sent',
  'awaiting_reply',
  'topup_1',
  'first_order',
  'topup_2',
  'shipped_sg',
  'closed_won',
  'closed_lost',
] as const;
export type Stage = (typeof STAGE_VALUES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new:             'New',
  contacted:       'Contacted',
  info_sent:       'Info sent',
  negotiating:     'Negotiating',
  sample_sent:     'Sample sent',
  awaiting_reply:  'Awaiting reply',
  topup_1:         'Top-up 1',
  first_order:     'First order',
  topup_2:         'Top-up 2',
  shipped_sg:      'Shipped',
  closed_won:      'Won',
  closed_lost:     'Lost',
};

export const INTENT_LABELS: Record<Intent, string> = {
  request_quote: 'Asking for price',
  question:      'Question',
  complaint:     'Complaint',
  showcase:      'Showcase',
  spam:          'Spam',
  seeding:       'Seeding',
  other:         'Other',
};

export interface TenantConfig {
  lead_intents: Intent[];
  classifier_enabled: boolean;
  classifier_model: string;
  // Phase C: Telegram notification config (per-tenant, customer sets via Settings)
  telegram_bot_token?: string | null;
  telegram_chat_id?: string | null;
  telegram_chat_title?: string | null;  // human-readable label, populated by /detect-chat
  telegram_topic_hr?: number | null;        // thread_id for HR/recruitment leads
  telegram_topic_fulfill?: number | null;   // thread_id for fulfill/supplier leads
  // Per-tenant random secret for the Telegram webhook URL + the secret_token
  // header. Generated automatically when bot_token is first saved.
  telegram_webhook_secret?: string | null;
  notify_intents?: Intent[];   // subset of intents that trigger Telegram (default = lead_intents)
  // Phase C5: customer-written shop description + lead criteria. When non-empty,
  // overrides the fixed 7-intent classifier — Gemini reads these rules + the
  // post and decides is_lead + free-form category.
  lead_rules?: string | null;
  lead_min_confidence?: number;  // 0-1, only create lead if Gemini confidence ≥ this (default 0)
  // Only classify posts whose created_time (FB post date) is within N days.
  // Older posts are skipped — avoids surfacing stale leads from months ago.
  // Default 7. Set 0 to disable the recency filter.
  lead_max_age_days?: number;
  // De-dup window: skip creating a lead (and alert) if the same author already
  // produced a lead with identical normalized content within N days. Default 7.
  // Set 0 to disable de-dup. Kills recruiter re-post spam.
  lead_dedup_days?: number;
  // Customer's own Gemini API key. When set, classifier + comment analyzer use
  // this key (cost billed to customer's Google account). When empty/null →
  // fallback to process.env.GEMINI_API_KEY (system shared key, billed to admin).
  gemini_api_key?: string | null;
  // Sale-flow: AI-suggest reply for each new lead → manual approve before send.
  auto_reply_enabled?: boolean;
  auto_reply_intents?: string[];        // optional intent filter — only generate for these
  auto_reply_shop_context?: string;     // extra context for AI prompt (fallback to lead_rules)
  max_posts_per_day?: number;           // rate limit for composed posts (default 20)
  max_replies_per_day?: number;         // rate limit for approved replies (default 50)
  // Display info for the FB account currently used to crawl (shown on Dashboard).
  // No automatic way to grab FB user's display name without auth, so user enters
  // these manually via Settings.
  fb_display_name?: string | null;
  fb_avatar_url?:   string | null;
}

const DEFAULT_CONFIG: TenantConfig = {
  lead_intents: ['request_quote', 'question', 'complaint'],
  classifier_enabled: true,
  classifier_model: 'gemini-2.5-flash',
  telegram_bot_token: null,
  telegram_chat_id: null,
  telegram_chat_title: null,
  telegram_topic_hr: null,
  telegram_topic_fulfill: null,
  notify_intents: undefined,
  lead_rules: null,
  lead_min_confidence: 0,
  lead_max_age_days: 1,
  lead_dedup_days: 7,
  fb_display_name: null,
  fb_avatar_url:   null,
};

/** Read tenant config (cached for 60s — settings change rarely). */
const cache = new Map<string, { cfg: TenantConfig; at: number }>();
const TTL_MS = 60_000;

export async function getTenantConfig(tenantId = 'default'): Promise<TenantConfig> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cfg;
  const { rows } = await pool.query('SELECT config FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  const cfg: TenantConfig = { ...DEFAULT_CONFIG, ...(rows[0]?.config ?? {}) };
  cache.set(tenantId, { cfg, at: Date.now() });
  return cfg;
}

export function invalidateTenantConfig(tenantId = 'default'): void {
  cache.delete(tenantId);
}

export async function patchTenantConfig(tenantId: string, patch: Partial<TenantConfig>): Promise<TenantConfig> {
  // jsonb concat (||) overrides keys with the same name → simple shallow merge
  const { rows } = await pool.query(
    `INSERT INTO tenant_settings (tenant_id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET config = tenant_settings.config || EXCLUDED.config,
           updated_at = now()
     RETURNING config`,
    [tenantId, JSON.stringify(patch)]
  );
  invalidateTenantConfig(tenantId);
  return { ...DEFAULT_CONFIG, ...rows[0].config };
}
