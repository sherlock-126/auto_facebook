/**
 * Push pending reply suggestions to the customer's Telegram + handle their
 * approve / edit / skip taps.
 *
 *   When `reply_generator.ts` inserts a new `fb_reply_queue` row, it also calls
 *   `pushReplyNotification()` here → bot sends a card with 3 buttons.
 *
 *   Tap ✓ Gửi → status=approved + agent_commands enqueue (mirrors the existing
 *               /api/replies/queue/:id/approve flow). Bot edits card to
 *               "⏳ Đang gửi…", agent posts, action-result callback edits to
 *               "✓ Đã gửi: <permalink>".
 *
 *   Tap ✏ Edit → bot sets state=reply_edit_text + asks "Gõ reply mới:" →
 *               user sends text → bot updates suggested_text → re-shows card
 *               OR auto-approves with the new text (we auto-approve to save
 *               1 step — user explicitly wrote it).
 *
 *   Tap ✗ Skip → status=skipped; bot edits card to "✗ Đã bỏ qua".
 */
import { pool } from '../db.js';
import { getTenantConfig } from '../leads/pipeline.js';
import { sendMessage, editMessageText, answerCallbackQuery, escapeHtml, type InlineKeyboardButton } from './api.js';
import { setState, clearState } from './state.js';

interface NotifyArgs {
  tenantId:        string;
  replyId:         number | bigint;
  postPermalink:   string | null;
  postMessage:     string;
  authorName:      string | null;
  groupName:       string | null;
  intent:          string | null;
  suggestedText:   string;
}

function replyKeyboard(replyId: number | bigint): InlineKeyboardButton[][] {
  const id = String(replyId);
  return [
    [
      { text: '✓ Gửi',  callback_data: `rpl_ok:${id}` },
      { text: '✏ Edit', callback_data: `rpl_ed:${id}` },
      { text: '✗ Skip', callback_data: `rpl_no:${id}` },
    ],
  ];
}

function cardText(a: NotifyArgs): string {
  const lines = [
    `💬 <b>Lead mới — cần duyệt reply</b>`,
    '',
  ];
  if (a.groupName) lines.push(`📍 ${escapeHtml(a.groupName)}`);
  if (a.intent)    lines.push(`🏷 <i>${escapeHtml(a.intent)}</i>`);
  if (a.authorName) lines.push(`👤 ${escapeHtml(a.authorName)}`);
  if (a.postPermalink) lines.push(`<a href="${escapeHtml(a.postPermalink)}">📎 Xem post</a>`);
  lines.push('');
  lines.push(`<b>Post của khách:</b>`);
  lines.push(`<i>${escapeHtml((a.postMessage || '').slice(0, 600))}</i>`);
  lines.push('');
  lines.push(`<b>💬 AI suggest:</b>`);
  lines.push(escapeHtml(a.suggestedText));
  return lines.join('\n');
}

export async function pushReplyNotification(a: NotifyArgs): Promise<void> {
  const cfg = await getTenantConfig(a.tenantId);
  if (!cfg.telegram_bot_token || !cfg.telegram_chat_id) return;
  const r = await sendMessage(cfg.telegram_bot_token, cfg.telegram_chat_id, cardText(a),
    { replyMarkup: { inline_keyboard: replyKeyboard(a.replyId) } });
  if (r.ok && r.message_id) {
    await pool.query(
      `UPDATE fb_reply_queue SET bot_chat_id = $2, bot_message_id = $3 WHERE id = $1`,
      [a.replyId, cfg.telegram_chat_id, r.message_id],
    );
  }
}

/**
 * Bot edits its card after the agent reports back (called from action-result handler).
 *   status='sent'         → "✓ Đã gửi: <permalink>"
 *   status='failed'       → "✗ Lỗi: <err>"
 *   status='rate_limited' → "⏳ FB rate-limited, sẽ retry sau"
 */
export async function notifyReplyResult(
  tenantId: string,
  replyId: number,
  status: 'sent' | 'failed' | 'rate_limited',
  fbCommentUrl: string | null,
  error: string | null,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT q.bot_chat_id, q.bot_message_id, q.final_text, q.suggested_text, q.post_permalink
       FROM fb_reply_queue q WHERE q.id = $1 AND q.tenant_id = $2`,
    [replyId, tenantId],
  );
  const r = rows[0];
  if (!r?.bot_chat_id || !r?.bot_message_id) return;
  const cfg = await getTenantConfig(tenantId);
  if (!cfg.telegram_bot_token) return;
  const body = r.final_text || r.suggested_text;
  let txt: string;
  if (status === 'sent') {
    txt = `✓ <b>Đã gửi reply</b>${fbCommentUrl ? `\n<a href="${escapeHtml(fbCommentUrl)}">📎 Xem comment</a>` : ''}\n\n<i>${escapeHtml((body || '').slice(0, 400))}</i>`;
  } else if (status === 'rate_limited') {
    txt = `⏳ <b>FB rate-limited</b> — reply sẽ thử lại sau\n\n<i>${escapeHtml((body || '').slice(0, 400))}</i>`;
  } else {
    txt = `✗ <b>Lỗi gửi reply</b>: ${escapeHtml((error || '').slice(0, 200))}\n\n<i>${escapeHtml((body || '').slice(0, 400))}</i>`;
  }
  await editMessageText(cfg.telegram_bot_token, r.bot_chat_id, r.bot_message_id, txt);
}

/** Similar callback for post compose result. */
export async function notifyPostResult(
  tenantId: string,
  postId: number,
  status: 'posted' | 'failed' | 'rate_limited' | 'pending_review',
  fbPostUrl: string | null,
  error: string | null,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT bot_chat_id, bot_message_id, content,
            (SELECT name FROM dim_group WHERE group_id = fb_post_queue.group_id AND tenant_id = fb_post_queue.tenant_id LIMIT 1) AS group_name
       FROM fb_post_queue WHERE id = $1 AND tenant_id = $2`,
    [postId, tenantId],
  );
  const r = rows[0];
  if (!r?.bot_chat_id || !r?.bot_message_id) return;
  const cfg = await getTenantConfig(tenantId);
  if (!cfg.telegram_bot_token) return;
  let txt: string;
  if (status === 'posted') {
    txt = `✓ <b>Đã đăng bài</b>${fbPostUrl ? `\n<a href="${escapeHtml(fbPostUrl)}">📎 Xem bài</a>` : ''}\n\n📍 ${escapeHtml(r.group_name || '')}\n<i>${escapeHtml((r.content || '').slice(0, 400))}</i>`;
  } else if (status === 'pending_review') {
    txt = `⏳ <b>Đang chờ admin group duyệt</b>\n\n📍 ${escapeHtml(r.group_name || '')}\n<i>${escapeHtml((r.content || '').slice(0, 400))}</i>`;
  } else if (status === 'rate_limited') {
    txt = `⏳ <b>FB rate-limited</b> — đợi 1-2h rồi /post lại\n\n<i>${escapeHtml((r.content || '').slice(0, 400))}</i>`;
  } else {
    txt = `✗ <b>Lỗi đăng bài</b>: ${escapeHtml((error || '').slice(0, 200))}\n\n📍 ${escapeHtml(r.group_name || '')}\n<i>${escapeHtml((r.content || '').slice(0, 400))}</i>`;
  }
  await editMessageText(cfg.telegram_bot_token, r.bot_chat_id, r.bot_message_id, txt);
}

/** Handler for inline button taps on a reply card. */
export async function handleReplyCallback(
  tenantId: string,
  botToken: string,
  chatId: string,
  userEmail: string | null,
  callbackId: string,
  data: string,
  messageId: number | null,
): Promise<void> {
  const [op, idStr] = data.split(':');
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) {
    await answerCallbackQuery(botToken, callbackId, 'Invalid id');
    return;
  }

  if (op === 'rpl_ok') {
    // Approve + dispatch
    const { rows } = await pool.query(
      `UPDATE fb_reply_queue
          SET status='approved',
              approved_at = NOW(),
              approved_by = $2,
              final_text = COALESCE(final_text, suggested_text)
        WHERE id=$1 AND tenant_id=$3 AND status='pending_review'
       RETURNING id, post_permalink, COALESCE(final_text, suggested_text) AS body`,
      [id, userEmail ?? 'telegram', tenantId],
    );
    if (!rows[0]) { await answerCallbackQuery(botToken, callbackId, 'Reply không còn pending'); return; }
    if (!rows[0].post_permalink) {
      await pool.query(`UPDATE fb_reply_queue SET status='failed', error='no_post_permalink' WHERE id=$1`, [id]);
      await answerCallbackQuery(botToken, callbackId, 'Thiếu post permalink');
      if (messageId) await editMessageText(botToken, chatId, messageId, '✗ Reply lỗi: post không có permalink');
      return;
    }
    await pool.query(
      `INSERT INTO agent_commands (tenant_id, cmd, payload)
       VALUES ($1, 'comment_on_post', $2::jsonb)`,
      [tenantId, JSON.stringify({ action_id: rows[0].id, post_url: rows[0].post_permalink, content: rows[0].body })],
    );
    await answerCallbackQuery(botToken, callbackId, '✓ Đã queue');
    if (messageId) {
      await editMessageText(botToken, chatId, messageId,
        `⏳ <b>Đang gửi reply…</b>\n\n<i>${escapeHtml((rows[0].body || '').slice(0, 400))}</i>`);
    }
    return;
  }

  if (op === 'rpl_no') {
    const { rowCount } = await pool.query(
      `UPDATE fb_reply_queue SET status='skipped' WHERE id=$1 AND tenant_id=$2 AND status='pending_review'`,
      [id, tenantId],
    );
    await answerCallbackQuery(botToken, callbackId, rowCount ? 'Đã skip' : 'Không còn pending');
    if (messageId && rowCount) await editMessageText(botToken, chatId, messageId, '✗ Đã bỏ qua');
    return;
  }

  if (op === 'rpl_ed') {
    // Set state, ask for new text
    await setState({
      tenant_id: tenantId, chat_id: chatId,
      state_name: 'reply_edit_text',
      payload: { reply_id: id, card_message_id: messageId },
    });
    await answerCallbackQuery(botToken, callbackId);
    await sendMessage(botToken, chatId, '✏ <b>Gõ reply mới</b> (tin nhắn tiếp theo). Bot sẽ auto-gửi sau khi nhận text. Gõ /cancel để huỷ.');
    return;
  }

  await answerCallbackQuery(botToken, callbackId, 'Lệnh không hợp lệ');
}

/**
 * Called when user is in state=reply_edit_text and sends a plain text message.
 * Updates final_text + dispatches (skip another approve step — they explicitly
 * wrote the text just now).
 */
export async function handleReplyEditText(
  tenantId: string,
  botToken: string,
  chatId: string,
  userEmail: string | null,
  newText: string,
  replyId: number,
  cardMessageId: number | null,
): Promise<void> {
  await clearState(tenantId, chatId);
  const body = newText.trim();
  if (body.length < 3) {
    await sendMessage(botToken, chatId, '✗ Reply quá ngắn (cần ≥3 ký tự).');
    return;
  }
  const { rows } = await pool.query(
    `UPDATE fb_reply_queue
        SET status='approved', final_text=$2, approved_at=NOW(), approved_by=$3
      WHERE id=$1 AND tenant_id=$4 AND status='pending_review'
     RETURNING id, post_permalink`,
    [replyId, body, userEmail ?? 'telegram-edit', tenantId],
  );
  if (!rows[0]) {
    await sendMessage(botToken, chatId, '✗ Reply không còn pending (đã được duyệt / skip ở chỗ khác?).');
    return;
  }
  if (!rows[0].post_permalink) {
    await pool.query(`UPDATE fb_reply_queue SET status='failed', error='no_post_permalink' WHERE id=$1`, [replyId]);
    await sendMessage(botToken, chatId, '✗ Lỗi: post không có permalink.');
    return;
  }
  await pool.query(
    `INSERT INTO agent_commands (tenant_id, cmd, payload)
     VALUES ($1, 'comment_on_post', $2::jsonb)`,
    [tenantId, JSON.stringify({ action_id: rows[0].id, post_url: rows[0].post_permalink, content: body })],
  );
  if (cardMessageId) {
    await editMessageText(botToken, chatId, cardMessageId,
      `⏳ <b>Đang gửi reply (edited)…</b>\n\n<i>${escapeHtml(body.slice(0, 400))}</i>`);
  } else {
    await sendMessage(botToken, chatId, `⏳ <b>Đã queue reply</b>\n\n<i>${escapeHtml(body.slice(0, 400))}</i>`);
  }
}
