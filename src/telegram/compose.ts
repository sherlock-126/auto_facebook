/**
 * Compose-post flow over Telegram bot.
 *
 *   User: /post bán hoa tươi giao SG, ưu đãi tháng 6
 *   Bot:  ⏳ Đang gen 3 phiên bản…
 *   Bot:  Chọn variant:
 *         1) ...
 *         2) ...
 *         3) ...
 *         [1] [2] [3]  [🔄 Regen]  [❌ Huỷ]
 *   User taps [2]
 *   Bot:  Đăng vào group nào?
 *         [Group A] [Group B] ... [❌ Huỷ]
 *   User taps group
 *   Bot:  ✓ Đã queue. Agent sẽ đăng trong ~60s.
 *   ... agent posts ...
 *   Bot edits message → ✓ Đã đăng: <permalink>
 *
 * Edge cases:
 *   /post (no body) → ask "Bạn muốn đăng gì?"
 *   Regen → re-call Gemini with same idea (max 3 regens to avoid burning quota)
 *   No enabled groups → "Chưa bật group nào — vào dashboard enable trước"
 */
import { GoogleGenAI } from '@google/genai';
import { pool } from '../db.js';
import { getTenantConfig } from '../leads/pipeline.js';
import { logGeminiUsage } from '../leads/gemini_usage.js';
import { sendMessage, editMessageText, answerCallbackQuery, escapeHtml, type InlineKeyboardButton } from './api.js';
import { setState, clearState, getState } from './state.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const MAX_GROUPS_IN_PICKER = 12;
const MAX_REGENS = 3;

const clientByKey = new Map<string, GoogleGenAI>();
function getClient(apiKey: string | null | undefined): GoogleGenAI | null {
  const key = (apiKey && apiKey.trim()) || process.env.GEMINI_API_KEY;
  if (!key) return null;
  const c = clientByKey.get(key);
  if (c) return c;
  const fresh = new GoogleGenAI({ apiKey: key });
  clientByKey.set(key, fresh);
  return fresh;
}

const COMPOSE_PROMPT = `Bạn là copywriter cho shop nhỏ ở VN. Viết 3 phiên bản post Facebook group khác nhau (khác giọng văn, khác mở bài) cho idea sau. Mỗi version 80-200 từ, tự nhiên không corporate, không spam, không emoji thừa. Có thể có 1-2 emoji nhẹ. Không dùng "Hi quý khách", "Dạ thưa".

Trả JSON đúng format này (KHÔNG có markdown, KHÔNG có quote):
{"variants": ["text 1", "text 2", "text 3"]}`;

interface VariantCacheEntry { variants: string[]; idea: string; regens: number; }

async function genVariants(tenantId: string, idea: string): Promise<string[] | null> {
  const cfg = await getTenantConfig(tenantId);
  const client = getClient(cfg.gemini_api_key);
  if (!client) return null;
  const shopCtx = (cfg.auto_reply_shop_context && cfg.auto_reply_shop_context.trim())
    || cfg.lead_rules
    || '(shop chưa mô tả)';
  const userPrompt = [
    `MÔ TẢ SHOP:`,
    shopCtx,
    ``,
    `IDEA POST:`,
    idea,
    ``,
    `Viết 3 variants.`,
  ].join('\n');
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: COMPOSE_PROMPT,
        temperature: 0.9,
        responseMimeType: 'application/json',
      },
    });
    void logGeminiUsage(tenantId, MODEL, 'compose_variants', (res as any)?.usageMetadata, true);
    const text = (res.text ?? '').trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.variants)) return null;
    return parsed.variants.slice(0, 3).filter((v: any) => typeof v === 'string' && v.length >= 30);
  } catch (e: any) {
    void logGeminiUsage(tenantId, MODEL, 'compose_variants', null, false, String(e?.message ?? e).slice(0, 300));
    return null;
  }
}

async function listEnabledGroups(tenantId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await pool.query(
    `SELECT group_id AS id, name FROM dim_group
      WHERE tenant_id = $1 AND enabled = TRUE
      ORDER BY name NULLS LAST LIMIT $2`,
    [tenantId, MAX_GROUPS_IN_PICKER],
  );
  return rows.map((r: any) => ({ id: r.id, name: r.name || r.id }));
}

function fmtVariantsText(variants: string[], idea: string): string {
  const head = `📝 <b>Idea:</b> <i>${escapeHtml(idea.slice(0, 200))}</i>\n\n`;
  return head + variants.map((v, i) =>
    `<b>${i + 1}.</b> ${escapeHtml(v.slice(0, 800))}`
  ).join('\n\n━━━━━━━━━━━\n\n');
}

function variantKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: '1', callback_data: 'cps_v:1' },
      { text: '2', callback_data: 'cps_v:2' },
      { text: '3', callback_data: 'cps_v:3' },
    ],
    [
      { text: '🔄 Regenerate',  callback_data: 'cps_regen' },
      { text: '❌ Cancel',    callback_data: 'cps_cancel' },
    ],
  ];
}

function groupKeyboard(groups: { id: string; name: string }[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < groups.length; i += 2) {
    const row = [groups[i], groups[i + 1]].filter(Boolean).map((g) => ({
      text: g.name.slice(0, 30),
      callback_data: `cps_g:${g.id}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'cps_cancel' }]);
  return rows;
}

/** Entry point: user sent `/post ...` or, if in compose_input_idea state, plain text. */
export async function handleComposeStart(
  tenantId: string,
  botToken: string,
  chatId: string,
  userId: number | null,
  ideaRaw: string,
): Promise<void> {
  const idea = ideaRaw.trim();
  if (!idea) {
    await setState({ tenant_id: tenantId, chat_id: chatId, state_name: 'compose_input_idea', payload: {} });
    await sendMessage(botToken, chatId, '📝 What would you like to post? Type your idea in the next message.\n\nExample: <i>fresh flowers, 20% off in June, delivery to Saigon</i>\n\nType /cancel to cancel.');
    return;
  }
  const groups = await listEnabledGroups(tenantId);
  if (!groups.length) {
    await sendMessage(botToken, chatId, '⚠ No groups enabled for posting. Go to dashboard → Groups → enable at least 1 group first.');
    return;
  }
  const status = await sendMessage(botToken, chatId, '⏳ Generating 3 versions…');
  const variants = await genVariants(tenantId, idea);
  if (!variants || !variants.length) {
    if (status.message_id) await editMessageText(botToken, chatId, status.message_id, '✗ Generation failed. Try a different /post idea or check your Gemini API key in Settings.');
    return;
  }
  if (status.message_id) {
    await editMessageText(botToken, chatId, status.message_id, fmtVariantsText(variants, idea), { replyMarkup: { inline_keyboard: variantKeyboard() } });
  }
  await setState({
    tenant_id: tenantId, chat_id: chatId,
    state_name: 'compose_pick_variant',
    payload: { variants, idea, regens: 0, msg_id: status.message_id } as VariantCacheEntry & { msg_id?: number },
  });
}

/** Callback from inline button. data is one of: cps_v:N, cps_regen, cps_cancel, cps_g:GROUP_ID */
export async function handleComposeCallback(
  tenantId: string,
  botToken: string,
  chatId: string,
  userId: number | null,
  callbackId: string,
  data: string,
  messageId: number | null,
): Promise<void> {
  if (data === 'cps_cancel') {
    await clearState(tenantId, chatId);
    await answerCallbackQuery(botToken, callbackId, 'Cancelled');
    if (messageId) await editMessageText(botToken, chatId, messageId, '❌ Cancelled');
    return;
  }
  const st = await getState(tenantId, chatId);
  if (!st) {
    await answerCallbackQuery(botToken, callbackId, 'Session expired, type /post again');
    return;
  }
  // Regen
  if (data === 'cps_regen' && st.state_name === 'compose_pick_variant') {
    const p = st.payload as VariantCacheEntry & { msg_id?: number };
    if ((p.regens || 0) >= MAX_REGENS) {
      await answerCallbackQuery(botToken, callbackId, 'Already regenerated 3 times — try a new idea');
      return;
    }
    await answerCallbackQuery(botToken, callbackId, '⏳ Regenerating…');
    const variants = await genVariants(tenantId, p.idea);
    if (!variants || !variants.length) {
      if (messageId) await editMessageText(botToken, chatId, messageId, '✗ Generation failed. Try a different /post idea.');
      await clearState(tenantId, chatId);
      return;
    }
    if (messageId) await editMessageText(botToken, chatId, messageId, fmtVariantsText(variants, p.idea), { replyMarkup: { inline_keyboard: variantKeyboard() } });
    await setState({
      tenant_id: tenantId, chat_id: chatId,
      state_name: 'compose_pick_variant',
      payload: { variants, idea: p.idea, regens: (p.regens || 0) + 1, msg_id: messageId },
    });
    return;
  }
  // Variant pick
  if (data.startsWith('cps_v:') && st.state_name === 'compose_pick_variant') {
    const n = parseInt(data.slice(6), 10);
    const p = st.payload as VariantCacheEntry;
    const chosen = p.variants[n - 1];
    if (!chosen) { await answerCallbackQuery(botToken, callbackId, 'Variant does not exist'); return; }
    const groups = await listEnabledGroups(tenantId);
    if (!groups.length) { await answerCallbackQuery(botToken, callbackId, 'No groups enabled'); return; }
    await answerCallbackQuery(botToken, callbackId, `✓ Selected variant ${n}`);
    if (messageId) {
      await editMessageText(botToken, chatId, messageId,
        `✓ <b>Selected variant ${n}</b>\n\n<i>${escapeHtml(chosen.slice(0, 600))}</i>\n\n📍 <b>Which group to post to?</b>`,
        { replyMarkup: { inline_keyboard: groupKeyboard(groups) } },
      );
    }
    await setState({
      tenant_id: tenantId, chat_id: chatId,
      state_name: 'compose_pick_group',
      payload: { content: chosen, idea: p.idea, msg_id: messageId },
    });
    return;
  }
  // Group pick
  if (data.startsWith('cps_g:') && st.state_name === 'compose_pick_group') {
    const groupId = data.slice(6);
    const p = st.payload as { content: string; idea: string };
    const { rows } = await pool.query(
      `SELECT name FROM dim_group WHERE tenant_id = $1 AND group_id = $2 AND enabled = TRUE`,
      [tenantId, groupId],
    );
    if (!rows[0]) { await answerCallbackQuery(botToken, callbackId, 'Group does not exist / not enabled'); return; }
    const groupName = rows[0].name || groupId;
    const { rows: ins } = await pool.query(
      `INSERT INTO fb_post_queue (tenant_id, group_id, content, schedule_at, status, created_by, bot_chat_id, bot_message_id)
       VALUES ($1, $2, $3, NOW(), 'pending', $4, $5, $6)
       RETURNING id`,
      [tenantId, groupId, p.content, `telegram:${userId ?? '?'}`, chatId, messageId],
    );
    await clearState(tenantId, chatId);
    await answerCallbackQuery(botToken, callbackId, '✓ Queued');
    if (messageId) {
      await editMessageText(botToken, chatId, messageId,
        `✓ <b>Queued (#${ins[0].id})</b>\n\n📍 Group: <b>${escapeHtml(groupName)}</b>\n\n<i>${escapeHtml(p.content.slice(0, 400))}</i>\n\n⏳ The agent will post in ~30-60s. The bot will let you know when it is done.`,
      );
    }
    return;
  }
  await answerCallbackQuery(botToken, callbackId, 'Invalid command');
}
