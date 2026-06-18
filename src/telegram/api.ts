/**
 * Thin wrapper around the Telegram Bot HTTP API. No SDK — we only need ~6
 * methods (sendMessage, editMessageText, editReplyMarkup, answerCallbackQuery,
 * setWebhook, deleteWebhook). Per-tenant: every call takes botToken explicitly.
 *
 * NOTE: notifier.ts has its own internal helpers from before this module
 * existed; kept there for code-locality of the lead-alert format. New code
 * uses this module.
 */

const TIMEOUT_MS = 15_000;

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}
export interface ReplyMarkup {
  inline_keyboard?: InlineKeyboardButton[][];
  force_reply?: boolean;
  remove_keyboard?: boolean;
}

async function call<T = any>(botToken: string, method: string, body: any): Promise<{ ok: boolean; result?: T; description?: string }> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    return { ok: !!j.ok, result: j.result, description: j.description };
  } catch (e: any) {
    return { ok: false, description: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  opts: { replyMarkup?: ReplyMarkup; parseMode?: 'HTML' | 'MarkdownV2' } = {},
): Promise<{ ok: boolean; message_id?: number; description?: string }> {
  const r = await call<{ message_id: number }>(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode ?? 'HTML',
    disable_web_page_preview: true,
    reply_markup: opts.replyMarkup,
  });
  return { ok: r.ok, message_id: r.result?.message_id, description: r.description };
}

export async function editMessageText(
  botToken: string,
  chatId: string | number,
  messageId: number,
  text: string,
  opts: { replyMarkup?: ReplyMarkup; parseMode?: 'HTML' | 'MarkdownV2' } = {},
): Promise<{ ok: boolean; description?: string }> {
  return call(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parseMode ?? 'HTML',
    disable_web_page_preview: true,
    reply_markup: opts.replyMarkup,
  });
}

export async function editReplyMarkup(
  botToken: string,
  chatId: string | number,
  messageId: number,
  replyMarkup: ReplyMarkup | null,
): Promise<{ ok: boolean; description?: string }> {
  return call(botToken, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  void call(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text?.slice(0, 200),
  });
}

export async function setWebhook(
  botToken: string,
  url: string,
  secretToken: string,
): Promise<{ ok: boolean; description?: string }> {
  return call(botToken, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(botToken: string): Promise<{ ok: boolean; description?: string }> {
  return call(botToken, 'deleteWebhook', { drop_pending_updates: true });
}

export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
