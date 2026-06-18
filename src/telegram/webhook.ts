/**
 * Telegram webhook receiver. URL pattern:
 *
 *   POST https://fb.autonow.vn/api/telegram/wh/:secret
 *
 * `secret` is a per-tenant random token stored in tenant_settings.config
 * (jsonb key `telegram_webhook_secret`). On setWebhook we also send a
 * `secret_token` to Telegram, which Telegram echoes in the
 * `X-Telegram-Bot-Api-Secret-Token` header — we verify both match.
 *
 * Update types we handle:
 *   - message.text starting with /post, /cancel, /help   → command
 *   - message.text plain (no slash)                       → check state machine
 *   - callback_query                                      → button taps
 *
 * Everything else (photos, edits, reactions, channel posts) → 200 OK + ignore.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { sendMessage } from './api.js';
import { getState, clearState } from './state.js';
import { handleComposeStart, handleComposeCallback } from './compose.js';
import { handleReplyCallback, handleReplyEditText } from './reply_notify.js';
import { handleLeadBlockCallback } from '../leads/blocklist.js';

interface TenantLookup {
  tenant_id: string;
  bot_token: string;
}

async function lookupBySecret(secret: string): Promise<TenantLookup | null> {
  // tenant_settings.config->>'telegram_webhook_secret' = $1
  const { rows } = await pool.query(
    `SELECT tenant_id,
            config->>'telegram_bot_token' AS bot_token
       FROM tenant_settings
      WHERE config->>'telegram_webhook_secret' = $1
        AND config->>'telegram_bot_token' IS NOT NULL`,
    [secret],
  );
  return rows[0] ?? null;
}

const HELP_TEXT = `<b>auto_facebook bot</b>

<b>/post &lt;idea&gt;</b> — generate 3 post versions + publish to a group
<b>/post</b> — no idea given, the bot will ask
<b>/cancel</b> — cancel the current flow
<b>/help</b> — show this menu

When a new lead arrives (with auto-reply enabled), the bot pushes a card with <b>✓ Send / ✏ Edit / ✗ Skip</b> buttons to approve the reply.`;

export async function registerTelegramWebhook(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { secret: string }; Body: any }>('/api/telegram/wh/:secret', async (req, reply) => {
    const sec = req.params.secret;
    const headerSec = (req.headers['x-telegram-bot-api-secret-token'] ?? '') as string;
    if (!sec || sec.length < 16) return reply.status(404).send();
    if (headerSec !== sec) return reply.status(403).send({ error: 'bad_secret_header' });
    const t = await lookupBySecret(sec);
    if (!t) return reply.status(404).send({ error: 'tenant_not_found' });

    // Always 200 OK fast — Telegram retries on non-2xx (and accumulates queue).
    reply.send({ ok: true });
    void processUpdate(t, req.body).catch((e) => {
      console.warn(`[tg-webhook] processUpdate failed tenant=${t.tenant_id}: ${e?.message ?? e}`);
    });
  });
}

async function processUpdate(t: TenantLookup, upd: any): Promise<void> {
  if (!upd || typeof upd !== 'object') return;

  // ── Callback query (button tap) ─────────────────────────────────────
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const chatId = String(cq.message?.chat?.id ?? '');
    const data: string = cq.data ?? '';
    const messageId: number | null = cq.message?.message_id ?? null;
    const userId: number | null = cq.from?.id ?? null;
    const userEmail = cq.from?.username ? `tg:${cq.from.username}` : (userId ? `tg:${userId}` : null);
    if (!chatId || !data) return;
    if (data.startsWith('cps_')) {
      await handleComposeCallback(t.tenant_id, t.bot_token, chatId, userId, cq.id, data, messageId);
      return;
    }
    if (data.startsWith('rpl_')) {
      await handleReplyCallback(t.tenant_id, t.bot_token, chatId, userEmail, cq.id, data, messageId);
      return;
    }
    if (data.startsWith('lead_block:')) {
      await handleLeadBlockCallback(t.tenant_id, t.bot_token, chatId, userEmail, cq.id, data, messageId);
      return;
    }
    return;
  }

  // ── Message ─────────────────────────────────────────────────────────
  const msg = upd.message ?? upd.edited_message;
  if (!msg) return;
  const chatId = String(msg.chat?.id ?? '');
  const userId: number | null = msg.from?.id ?? null;
  const userEmail = msg.from?.username ? `tg:${msg.from.username}` : (userId ? `tg:${userId}` : null);
  const text: string = (msg.text ?? '').trim();
  if (!chatId) return;

  // Commands
  if (text === '/start' || text === '/help' || text === '/start@yourbot') {
    await sendMessage(t.bot_token, chatId, HELP_TEXT);
    return;
  }
  if (text === '/cancel') {
    await clearState(t.tenant_id, chatId);
    await sendMessage(t.bot_token, chatId, '❌ Current flow cancelled.');
    return;
  }
  if (text.startsWith('/post')) {
    const idea = text.slice('/post'.length).trim();
    await handleComposeStart(t.tenant_id, t.bot_token, chatId, userId, idea);
    return;
  }

  // Stateful: continue an in-progress flow
  if (text) {
    const st = await getState(t.tenant_id, chatId);
    if (st?.state_name === 'compose_input_idea') {
      await handleComposeStart(t.tenant_id, t.bot_token, chatId, userId, text);
      return;
    }
    if (st?.state_name === 'reply_edit_text') {
      const p = st.payload as { reply_id: number; card_message_id: number | null };
      await handleReplyEditText(t.tenant_id, t.bot_token, chatId, userEmail, text, p.reply_id, p.card_message_id);
      return;
    }
  }
  // else: ignore (random chat noise)
}
