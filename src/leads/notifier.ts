/**
 * Telegram notification dispatcher — sends a lead alert to the tenant's
 * configured Telegram chat (set up via Settings → Telegram notification).
 *
 * Format: rich message with intent + author + group + message excerpt + inline
 * keyboard buttons (📩 IB if author is not anonymous, 💬 Comment, 📊 Update stage).
 *
 * Fire-and-forget — errors are logged but never propagated to the lead detector
 * (lead insert must not fail because Telegram is unhappy).
 */
import { pool } from '../db.js';
import { getTenantConfig, STAGE_LABELS, INTENT_LABELS, type Intent } from './pipeline.js';

const APP_BASE_URL = process.env.APP_PUBLIC_BASE_URL ?? 'https://nextclaw.vn';

interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}
interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/** Lightweight Telegram sendMessage call — no SDK needed. */
async function telegramSend(
  botToken: string,
  chatId: string,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
  threadId?: number | null,
): Promise<{ ok: boolean; description?: string }> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (threadId)   body.message_thread_id = threadId;
  return telegramApiCall(url, body);
}

/** Telegram sendPhoto — photo arg is a URL or file_id. Caption max 1024 chars. */
async function telegramSendPhoto(
  botToken: string,
  chatId: string,
  photoUrl: string,
  caption: string,
  replyMarkup?: TelegramReplyMarkup,
  threadId?: number | null,
): Promise<{ ok: boolean; description?: string }> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendPhoto`;
  const body: any = { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (threadId)   body.message_thread_id = threadId;
  return telegramApiCall(url, body);
}

/**
 * Decide which forum topic a lead belongs to, by keyword match on the
 * free-form Vietnamese category that Gemini returned. Order matters:
 * recruitment keywords are checked first (otherwise "fulfill" in a job ad
 * could leak into the wrong topic).
 */
function pickTopicId(category: string, cfg: { telegram_topic_hr?: number | null; telegram_topic_fulfill?: number | null }): number | null {
  const text = (category || '').toLowerCase();
  if (/tuyển|recruit|hiring|designer|seller|job|nhân viên|hr\b/.test(text)) {
    return cfg.telegram_topic_hr ?? null;
  }
  if (/fulfill|supplier|sup\b|xưởng|cung cấp|ff\b|nhà cung/.test(text)) {
    return cfg.telegram_topic_fulfill ?? null;
  }
  return null; // → general
}

async function telegramApiCall(url: string, body: any): Promise<{ ok: boolean; description?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    return { ok: !!j.ok, description: j.description };
  } catch (e: any) {
    return { ok: false, description: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the best photo URL out of a FB post's raw GraphQL response.
 * Tries the multiple shapes the agent parser doesn't currently extract
 * (`attachments[0].styles.attachment.media.photo_image.uri`, etc.).
 */
function extractPhotoUrl(raw: any, attachmentUrl: string | null): string | null {
  if (attachmentUrl && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(attachmentUrl)) return attachmentUrl;
  if (!raw || typeof raw !== 'object') return null;
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  for (const a of attachments) {
    const direct = [
      a?.styles?.attachment?.media?.photo_image?.uri,
      a?.styles?.attachment?.media?.image?.uri,
      a?.media?.photo_image?.uri,
      a?.media?.image?.uri,
    ];
    for (const p of direct) if (typeof p === 'string' && p.startsWith('http')) return p;
    // Album posts (StoryAttachmentAlbumStyleRenderer) — first photo of the album
    const albumNodes = a?.styles?.attachment?.all_subattachments?.nodes ?? a?.all_subattachments?.nodes ?? [];
    for (const n of albumNodes) {
      const u = n?.media?.image?.uri ?? n?.media?.photo_image?.uri;
      if (typeof u === 'string' && u.startsWith('http')) return u;
    }
    // Legacy
    for (const sub of (a?.subattachments ?? [])) {
      const u = sub?.media?.image?.uri ?? sub?.media?.photo_image?.uri;
      if (typeof u === 'string' && u.startsWith('http')) return u;
    }
  }
  return null;
}

/** Test the configured bot — sends a short ping. Used by Settings test button. */
export async function sendTelegramTest(tenantId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getTenantConfig(tenantId);
  if (!cfg.telegram_bot_token || !cfg.telegram_chat_id) {
    return { ok: false, error: 'bot_token + chat_id not configured' };
  }
  // Send 1 ping to each configured channel so user verifies routing works.
  const targets: { name: string; threadId: number | null }[] = [
    { name: 'General', threadId: null },
  ];
  if (cfg.telegram_topic_hr)      targets.push({ name: 'HR leads (recruitment)', threadId: cfg.telegram_topic_hr });
  if (cfg.telegram_topic_fulfill) targets.push({ name: 'Fulfill leads (supplier)', threadId: cfg.telegram_topic_fulfill });

  const errors: string[] = [];
  for (const t of targets) {
    const text = `🟢 <b>Test → ${escapeHtml(t.name)}</b>\n\nThis channel will receive <i>${escapeHtml(t.name)}</i>. If you see this message in the right topic, routing is OK.`;
    const r = await telegramSend(cfg.telegram_bot_token, cfg.telegram_chat_id, text, undefined, t.threadId);
    if (!r.ok) errors.push(`${t.name}: ${r.description}`);
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true };
}

/** Sent on each new lead. Fire-and-forget. */
export function sendLeadAlertFireAndForget(tenantId: string, leadId: number): void {
  void sendLeadAlert(tenantId, leadId).catch((e) =>
    console.warn(`[notifier] lead alert failed for tenant=${tenantId} lead=${leadId}: ${e?.message ?? e}`)
  );
}

async function sendLeadAlert(tenantId: string, leadId: number): Promise<void> {
  const cfg = await getTenantConfig(tenantId);
  if (!cfg.telegram_bot_token || !cfg.telegram_chat_id) return; // not configured → silent skip

  // Fetch lead + post + group in one query.
  const { rows } = await pool.query(
    `SELECT l.lead_id, l.intent, l.intent_confidence, l.author_id, l.org_name,
            p.message, p.permalink, p.is_anonymous_post, p.created_time,
            p.attachment_url, p.raw,
            g.group_id, g.name AS group_name
       FROM fact_lead l
       LEFT JOIN fact_group_post p USING (post_id)
       LEFT JOIN dim_group g ON g.group_id = l.group_id
      WHERE l.lead_id = $1 AND l.tenant_id = $2`,
    [leadId, tenantId]
  );
  const lead = rows[0];
  if (!lead) return;

  // Intent filter is for the legacy 7-intent enum classifier only. When the
  // tenant has written custom `lead_rules`, the rule itself is the filter —
  // any lead that reached this function already matched the user's criteria,
  // so skip the enum check (lead.intent is a free-form Vietnamese category).
  const usingRules = typeof cfg.lead_rules === 'string' && cfg.lead_rules.trim().length > 30;
  if (!usingRules) {
    const allowed = cfg.notify_intents ?? cfg.lead_intents;
    if (!allowed.includes(lead.intent as Intent)) return;
  }

  const intentLabel = INTENT_LABELS[lead.intent as Intent] ?? lead.intent;
  const confPct = Math.round((Number(lead.intent_confidence) || 0) * 100);
  const messageExcerpt = (lead.message ?? '').replace(/\s+/g, ' ').slice(0, 400);
  const groupName = lead.group_name ?? lead.group_id ?? '?';
  const actor: any = lead.raw?.actors?.[0] ?? null;
  const authorName: string | null    = actor?.name ?? null;
  const authorProfile: string | null = actor?.url  ?? null;
  // Anonymous detection — author has fake id but no profile url, OR FB-typed
  // as GroupAnonAuthorProfile / GroupAnonymousAuthor.
  const isAnon = lead.is_anonymous_post === true
    || actor?.__typename === 'GroupAnonAuthorProfile'
    || actor?.__typename === 'GroupAnonymousAuthor'
    || actor?.__isActor  === 'GroupAnonAuthorProfile'
    || (actor && actor.id && !authorProfile);
  // Display the actual FB-reported name. For anonymous posts FB returns "Người
  // tham gia ẩn danh" — we surface that verbatim and link to the post permalink
  // (no profile exists). For real users, link to their profile.
  const displayName = authorName ?? (lead.author_id ? `User ${lead.author_id}` : '?');
  const clickUrl    = isAnon
    ? (lead.permalink ?? null)
    : (authorProfile ?? (lead.author_id ? `https://www.facebook.com/${lead.author_id}` : null));
  const icon = isAnon ? '🎭' : '👤';
  const authorLine = clickUrl
    ? `${icon} <a href="${escapeHtml(clickUrl)}">${escapeHtml(displayName)}</a>`
    : `${icon} ${escapeHtml(displayName)}`;

  const postedLine = lead.created_time
    ? `🕒 Posted at <b>${formatVnTime(lead.created_time)}</b> · ${humanizeAgo(lead.created_time)}`
    : '';

  const text = [
    `🔥 <b>New lead — ${escapeHtml(intentLabel)}</b>  <i>(${confPct}%)</i>`,
    '',
    authorLine,
    `📍 <b>${escapeHtml(groupName)}</b>`,
    postedLine,
    '',
    `<i>${escapeHtml(messageExcerpt)}</i>`,
  ].filter(Boolean).join('\n');

  // Inline keyboard
  const row1: TelegramInlineKeyboardButton[] = [];
  if (!isAnon) {
    const profileUrl = authorProfile || (lead.author_id ? `https://www.facebook.com/${lead.author_id}` : null);
    if (profileUrl) row1.push({ text: '👤 Open profile', url: profileUrl });
  }
  if (lead.permalink) {
    row1.push({ text: '💬 View post', url: lead.permalink });
  }
  const row2: TelegramInlineKeyboardButton[] = [
    { text: '📊 Update stage', url: `${APP_BASE_URL}/#kanban?lead=${lead.lead_id}` },
  ];
  const inlineKeyboard: TelegramInlineKeyboardButton[][] = row1.length ? [row1, row2] : [row2];
  // Block button — only present when Gemini extracted org_name. Tap suppresses
  // future leads from this org + auto-archives existing siblings in kanban.
  const orgDisplay: string | null = lead.org_name ?? null;
  if (orgDisplay && orgDisplay.length >= 2) {
    inlineKeyboard.push([
      { text: `🚫 Block ${orgDisplay.slice(0, 24)}`, callback_data: `lead_block:${lead.lead_id}` },
    ]);
  }

  const threadId = pickTopicId(String(lead.intent ?? ''), cfg);
  const photoUrl = extractPhotoUrl(lead.raw, lead.attachment_url);
  if (photoUrl) {
    // Telegram caption max 1024 chars — trim more aggressively than sendMessage.
    const caption = text.length > 1000 ? text.slice(0, 980) + '…' : text;
    const r = await telegramSendPhoto(cfg.telegram_bot_token, cfg.telegram_chat_id, photoUrl, caption, { inline_keyboard: inlineKeyboard }, threadId);
    if (r.ok) return;
    console.warn(`[notifier] sendPhoto failed lead=${leadId}: ${r.description} — falling back to text`);
  }
  await telegramSend(cfg.telegram_bot_token, cfg.telegram_chat_id, text, { inline_keyboard: inlineKeyboard }, threadId);
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** Format a timestamp as Vietnam-local time, e.g. "23/05/2026 14:32". */
function formatVnTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/** "5 minutes ago" / "2 hours ago" / "3 days ago". */
function humanizeAgo(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60)      return `${s}s ago`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(s / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
