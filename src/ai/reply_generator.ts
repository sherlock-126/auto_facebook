/**
 * Generate AI-suggested reply text for a newly-detected lead. Called fire-and-
 * forget from detector.ts after a lead is created (if tenant has
 * auto_reply_enabled). Stored in fb_reply_queue with status=pending_review —
 * customer reviews + approves before the agent posts the comment.
 *
 * Manual-approve gate (not automated send) protects against FB anti-spam.
 */
import { GoogleGenAI } from '@google/genai';
import { pool } from '../db.js';
import { getTenantConfig, type TenantConfig } from '../leads/pipeline.js';
import { logGeminiUsage } from '../leads/gemini_usage.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

// Reuse per-tenant client cache pattern (each tenant may have own API key).
const clientByKey = new Map<string, GoogleGenAI>();
function getClient(apiKey: string | null | undefined): GoogleGenAI | null {
  const key = (apiKey && apiKey.trim()) || process.env.GEMINI_API_KEY;
  if (!key) return null;
  const cached = clientByKey.get(key);
  if (cached) return cached;
  const c = new GoogleGenAI({ apiKey: key });
  clientByKey.set(key, c);
  return c;
}

export interface GenerateReplyArgs {
  tenantId:  string;
  leadId:    number | bigint;
  postId:    string;
  postPermalink: string | null;
  postMessage:   string;
  authorName:    string | null;
  groupName:     string | null;
  intent:        string | null;
}

const SYSTEM_PROMPT = `Bạn là sale assistant cho 1 shop nhỏ ở VN. Khi 1 khách đăng bài tìm sản phẩm/dịch vụ, bạn viết 1 comment ngắn để giới thiệu shop có thể giúp.

QUY TẮC BẮT BUỘC:
- Tối đa 2-3 câu, viết tiếng Việt tự nhiên (không "Hi quý khách", không "Dạ thưa")
- Cá nhân hoá theo nội dung post — đề cập đến cái khách đang hỏi
- KHÔNG spam: không bỏ link, không số điện thoại, không emoji thừa
- Khép comment bằng lời mời inbox (vd "ib em nhé", "ib mình nhé") — không hối thúc
- Giọng văn: thân thiện, ngắn gọn, đúng vai shop nhỏ (KHÔNG corporate)

CHỈ TRẢ về phần text comment, không có quote, không markdown, không nhãn.`;

export async function generateAndQueueReply(args: GenerateReplyArgs): Promise<void> {
  const cfg = await getTenantConfig(args.tenantId);
  if (!cfg.auto_reply_enabled) return;

  // Optional intent filter
  if (cfg.auto_reply_intents && cfg.auto_reply_intents.length > 0 && args.intent) {
    const match = cfg.auto_reply_intents.some((i) =>
      args.intent!.toLowerCase().includes(i.toLowerCase()),
    );
    if (!match) return;
  }

  const client = getClient(cfg.gemini_api_key);
  if (!client) return; // no key — skip silently

  const shopContext = (cfg.auto_reply_shop_context && cfg.auto_reply_shop_context.trim())
    || cfg.lead_rules
    || '(shop chưa mô tả — viết generic)';

  const userPrompt = [
    `MÔ TẢ SHOP:`,
    `"""`,
    shopContext,
    `"""`,
    ``,
    args.groupName ? `GROUP: ${args.groupName}` : '',
    args.authorName ? `KHÁCH (tên FB): ${args.authorName}` : '',
    args.intent ? `LEAD INTENT (Gemini classify): ${args.intent}` : '',
    ``,
    `POST CỦA KHÁCH:`,
    `"""`,
    args.postMessage.slice(0, 2000),
    `"""`,
    ``,
    `Viết 1 comment reply.`,
  ].filter(Boolean).join('\n');

  let suggested = '';
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.7,
      },
    });
    void logGeminiUsage(args.tenantId, MODEL, 'reply_generator', (res as any)?.usageMetadata, true);
    suggested = (res.text ?? '').trim();
    // Strip surrounding quotes if Gemini added them.
    suggested = suggested.replace(/^["'`]+|["'`]+$/g, '').trim();
  } catch (e: any) {
    void logGeminiUsage(args.tenantId, MODEL, 'reply_generator', null, false, String(e?.message ?? e).slice(0, 300));
    return;
  }

  if (!suggested || suggested.length < 5 || suggested.length > 1000) return;

  try {
    const { rows } = await pool.query(
      `INSERT INTO fb_reply_queue
         (tenant_id, lead_id, post_id, post_permalink, suggested_text, status)
       VALUES ($1, $2, $3, $4, $5, 'pending_review')
       RETURNING id`,
      [args.tenantId, args.leadId, args.postId, args.postPermalink, suggested],
    );
    const replyId = rows[0]?.id as number | undefined;
    // Push to Telegram bot (fire-and-forget) so customer can approve from chat
    // without opening the dashboard.
    if (replyId && cfg.telegram_bot_token && cfg.telegram_chat_id) {
      void import('../telegram/reply_notify.js').then(({ pushReplyNotification }) =>
        pushReplyNotification({
          tenantId:      args.tenantId,
          replyId,
          postPermalink: args.postPermalink,
          postMessage:   args.postMessage,
          authorName:    args.authorName,
          groupName:     args.groupName,
          intent:        args.intent,
          suggestedText: suggested,
        }),
      ).catch((e) => console.warn(`[reply_generator] tg push failed: ${e?.message ?? e}`));
    }
  } catch (e: any) {
    // FK could fail if lead deleted between detector + here. Log + ignore.
    console.warn(`[reply_generator] insert failed: ${e?.message ?? e}`);
  }
}
