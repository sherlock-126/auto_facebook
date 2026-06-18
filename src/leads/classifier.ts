/**
 * Gemini-based intent classifier for FB group posts.
 *
 * Hits gemini-2.5-flash with a structured JSON schema (responseMimeType +
 * responseSchema) to avoid prompt-eng for JSON. Caches by sha256(message) so
 * the same message in N groups = 1 Gemini call.
 *
 * Fallback: if GEMINI_API_KEY missing or API fails → returns null (lead will
 * remain unclassified and can be backfilled later).
 */
import { createHash } from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { pool } from '../db.js';
import { INTENT_VALUES, getTenantConfig, type Intent } from './pipeline.js';
import { logGeminiUsage } from './gemini_usage.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

// Per-tenant Gemini client cache, keyed by API key. Allows different tenants
// to use different keys (their own bill) while sharing the system fallback key.
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

export interface ClassifyResult {
  intent: Intent;
  confidence: number;
  reason: string;
  entities: {
    product?: string;
    price_mentioned?: string;
    contact_mentioned?: string;
    urgency?: 'low' | 'medium' | 'high';
    org_name?: string | null;
  };
}

function hashMessage(msg: string): string {
  return createHash('sha256').update(msg).digest('hex');
}

async function readCache(hash: string): Promise<ClassifyResult | null> {
  const { rows } = await pool.query(
    'SELECT intent, confidence, reason, entities FROM lead_classifier_cache WHERE msg_hash = $1',
    [hash]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    intent: r.intent as Intent,
    confidence: Number(r.confidence),
    reason: r.reason,
    entities: r.entities ?? {},
  };
}

async function writeCache(hash: string, model: string, res: ClassifyResult): Promise<void> {
  await pool.query(
    `INSERT INTO lead_classifier_cache (msg_hash, intent, confidence, reason, entities, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (msg_hash) DO UPDATE
       SET intent = EXCLUDED.intent,
           confidence = EXCLUDED.confidence,
           reason = EXCLUDED.reason,
           entities = EXCLUDED.entities,
           model = EXCLUDED.model,
           cached_at = now()`,
    [hash, res.intent, res.confidence, res.reason, res.entities, model]
  );
}

const SYSTEM_PROMPT = `Bạn là AI phân loại bài viết Facebook group thương mại. Phân loại theo intent enum và rút thực thể quan trọng (sản phẩm, giá, số điện thoại/Zalo, mức độ khẩn cấp).

Quy tắc intent:
- request_quote: khách hỏi giá, "ib mình giá", "có sản phẩm X không", "báo giá giúp"
- question: hỏi tư vấn, cách dùng, kinh nghiệm (chưa rõ ý mua)
- complaint: phàn nàn về sản phẩm/dịch vụ đã mua
- showcase: khoe ảnh dùng sản phẩm, kết quả, before/after
- spam: bài quảng cáo công ty khác, link affiliate
- seeding: template kêu gọi like/share, content lặp lại, content tạo tương tác giả
- other: tâm sự, off-topic, vô thưởng vô phạt, hỏi về group rules

ORG_NAME: nếu post là tin tuyển dụng / quảng cáo shop / dịch vụ của 1 công ty/brand/shop có tên cụ thể (vd "HUTATO", "PRINTUZ", "VELORA tuyển designer"), extract tên đó vào entities.org_name (uppercase nếu là brand). Nếu là khách hàng cá nhân hỏi mua / hỏi tư vấn → null.

confidence là độ tự tin 0.0-1.0.
reason là 1 câu tiếng Việt ngắn giải thích.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: INTENT_VALUES as unknown as string[] },
    confidence: { type: Type.NUMBER },
    reason: { type: Type.STRING },
    entities: {
      type: Type.OBJECT,
      properties: {
        product: { type: Type.STRING, nullable: true },
        price_mentioned: { type: Type.STRING, nullable: true },
        contact_mentioned: { type: Type.STRING, nullable: true },
        urgency: { type: Type.STRING, enum: ['low', 'medium', 'high'], nullable: true },
        org_name: { type: Type.STRING, nullable: true },
      },
    },
  },
  required: ['intent', 'confidence', 'reason', 'entities'],
} as const;

export interface ClassifyContext {
  group_name?: string;
  bypass_cache?: boolean;
  tenant_id?: string;
}

/**
 * Wrap Gemini generateContent with inline backoff for transient errors
 * (503 UNAVAILABLE, 429 RESOURCE_EXHAUSTED, 504 DEADLINE_EXCEEDED). Tries
 * 3 times total with 1s / 4s / 16s delay (21s total worst case). Returns the
 * final response or throws the last error so the caller can decide whether to
 * cache the failure.
 */
async function generateWithBackoff(client: GoogleGenAI, req: any): Promise<any> {
  const DELAYS_MS = [1000, 4000, 16000];
  let lastErr: any;
  for (let i = 0; i <= DELAYS_MS.length; i++) {
    try {
      return await client.models.generateContent(req);
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const isTransient = /\b(503|429|504)\b/.test(msg)
        || /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|overload|high demand/i.test(msg);
      if (!isTransient || i === DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, DELAYS_MS[i]));
    }
  }
  throw lastErr;
}

export async function classifyMessage(message: string, ctx: ClassifyContext = {}): Promise<ClassifyResult | null> {
  const clean = (message || '').trim();
  if (clean.length === 0) return null;

  const hash = hashMessage(clean);
  if (!ctx.bypass_cache) {
    const cached = await readCache(hash);
    if (cached) return cached;
  }

  // Resolve tenant's own Gemini key (falls back to env if customer hasn't set one).
  const tenantId = ctx.tenant_id;
  if (!tenantId) throw new Error('classifier: ClassifyContext.tenant_id is required');
  const tcfg = await getTenantConfig(tenantId);
  const client = getClient(tcfg.gemini_api_key);
  if (!client) {
    // No API key configured — caller decides what to do (lead stays unclassified)
    return null;
  }

  const userPrompt =
    (ctx.group_name ? `Group: ${ctx.group_name}\n\n` : '') +
    `Bài viết:\n"""\n${clean}\n"""`;

  try {
    const res = await generateWithBackoff(client, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA as any,
        temperature: 0.1,
      },
    });
    void logGeminiUsage(tenantId, MODEL, 'classifier:enum', (res as any)?.usageMetadata, true);
    const text = res.text ?? '';
    if (!text) return null;
    const parsed = JSON.parse(text) as ClassifyResult;
    if (!INTENT_VALUES.includes(parsed.intent)) {
      console.warn(`[classifier] unexpected intent: ${parsed.intent}`);
      return null;
    }
    parsed.entities = parsed.entities ?? {};
    await writeCache(hash, MODEL, parsed);
    return parsed;
  } catch (e: any) {
    void logGeminiUsage(tenantId, MODEL, 'classifier:enum', null, false, String(e?.message ?? e).slice(0, 300));
    console.error(`[classifier] gemini call failed (after retries): ${e?.message ?? e}`);
    return null;
  }
}

export function classifierConfigured(): boolean {
  // System has SOME key (env fallback). Per-tenant override checked at call time.
  return !!process.env.GEMINI_API_KEY;
}

// ─────────────────────────────────────────────────────────────────────────
// Rules-based classifier (Phase C5)
// Customer writes a paragraph describing their shop + what counts as a lead.
// Gemini reads that paragraph + the post → returns is_lead + free-form category.
// Far more flexible than the fixed 7-intent enum because every customer's
// definition of "lead" is different (POD vs xe khách vs mỹ phẩm vs BĐS).
// ─────────────────────────────────────────────────────────────────────────

export interface RulesClassifyResult {
  is_lead: boolean;
  category: string;       // free-form, e.g. "hỏi giá in áo", "tìm xưởng dropship"
  confidence: number;     // 0-1
  reason: string;
  entities: {
    product?: string;
    price_mentioned?: string;
    contact_mentioned?: string;
    urgency?: 'low' | 'medium' | 'high';
    org_name?: string | null;
  };
}

const RULES_SYSTEM_PROMPT = `Bạn là AI phân loại lead cho 1 shop online tại Việt Nam.

Khách hàng đã cung cấp MÔ TẢ SHOP + TIÊU CHÍ LEAD bên dưới. Đọc kỹ.

Sau đó đọc bài viết Facebook và quyết định:
1. is_lead: true nếu bài viết MATCH tiêu chí lead của shop; false nếu không.
2. category: chuỗi ngắn (max 40 ký tự, tiếng Việt) mô tả LOẠI lead, vd "hỏi giá in áo POD", "tìm xưởng dropship", "khiếu nại giao hàng". Nếu is_lead=false thì để category="không phải lead".
3. confidence: 0.0-1.0
4. reason: 1 câu giải thích quyết định (max 200 ký tự).
5. entities: rút thực thể nếu có (sản phẩm, giá, contact, urgency, org_name).
   - org_name: nếu post là tin tuyển dụng / quảng cáo shop / dịch vụ của 1 công ty/brand/shop có tên cụ thể (vd "HUTATO", "PRINTUZ", "VELORA tuyển designer"), extract tên đó (uppercase nếu brand). Nếu khách cá nhân hỏi mua/tư vấn → null.

Trả JSON đúng schema, không kèm text khác.`;

const RULES_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_lead:    { type: Type.BOOLEAN },
    category:   { type: Type.STRING },
    confidence: { type: Type.NUMBER },
    reason:     { type: Type.STRING },
    entities: {
      type: Type.OBJECT,
      properties: {
        product:           { type: Type.STRING, nullable: true },
        price_mentioned:   { type: Type.STRING, nullable: true },
        contact_mentioned: { type: Type.STRING, nullable: true },
        urgency:           { type: Type.STRING, enum: ['low','medium','high'], nullable: true },
        org_name:          { type: Type.STRING, nullable: true },
      },
    },
  },
  required: ['is_lead', 'category', 'confidence', 'reason', 'entities'],
} as const;

async function readRulesCache(hash: string): Promise<RulesClassifyResult | null> {
  // Reuse same cache table; key by hash(message + rules) so changing rules invalidates.
  const { rows } = await pool.query(
    `SELECT intent AS category, confidence, reason, entities, model
       FROM lead_classifier_cache WHERE msg_hash = $1`,
    [hash]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  // Stored "is_lead:true|false" prefix in `model` column to remember verdict
  const isLead = typeof r.model === 'string' && r.model.startsWith('rules:true');
  return {
    is_lead: isLead,
    category: r.category,
    confidence: Number(r.confidence),
    reason: r.reason,
    entities: r.entities ?? {},
  };
}

async function writeRulesCache(hash: string, res: RulesClassifyResult): Promise<void> {
  await pool.query(
    `INSERT INTO lead_classifier_cache (msg_hash, intent, confidence, reason, entities, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (msg_hash) DO UPDATE
       SET intent = EXCLUDED.intent, confidence = EXCLUDED.confidence,
           reason = EXCLUDED.reason, entities = EXCLUDED.entities,
           model = EXCLUDED.model, cached_at = now()`,
    [hash, res.category, res.confidence, res.reason, res.entities, `rules:${res.is_lead}:${MODEL}`]
  );
}

export async function classifyWithRules(
  message: string,
  rules: string,
  ctx: ClassifyContext = {},
): Promise<RulesClassifyResult | null> {
  const clean = (message || '').trim();
  if (clean.length === 0) return null;

  // Hash includes the rules text — different rules ⇒ different cache key.
  const hash = createHash('sha256').update(rules + '' + clean).digest('hex');
  if (!ctx.bypass_cache) {
    const cached = await readRulesCache(hash);
    if (cached) return cached;
  }

  const tenantId = ctx.tenant_id;
  if (!tenantId) throw new Error('classifier: ClassifyContext.tenant_id is required');
  const tcfg = await getTenantConfig(tenantId);
  const client = getClient(tcfg.gemini_api_key);
  if (!client) return null;

  const userPrompt = [
    'MÔ TẢ SHOP + TIÊU CHÍ LEAD (khách hàng cung cấp):',
    '"""',
    rules.trim(),
    '"""',
    '',
    ctx.group_name ? `BÀI VIẾT (từ group "${ctx.group_name}"):` : 'BÀI VIẾT:',
    '"""',
    clean,
    '"""',
  ].join('\n');

  try {
    const res = await generateWithBackoff(client, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: RULES_SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: RULES_RESPONSE_SCHEMA as any,
        temperature: 0.1,
      },
    });
    void logGeminiUsage(tenantId, MODEL, 'classifier:rules', (res as any)?.usageMetadata, true);
    const text = res.text ?? '';
    if (!text) return null;
    const parsed = JSON.parse(text) as RulesClassifyResult;
    parsed.entities = parsed.entities ?? {};
    parsed.category = String(parsed.category || 'unknown').slice(0, 80);
    await writeRulesCache(hash, parsed);
    return parsed;
  } catch (e: any) {
    void logGeminiUsage(tenantId, MODEL, 'classifier:rules', null, false, String(e?.message ?? e).slice(0, 300));
    console.error(`[classifier:rules] gemini call failed (after retries): ${e?.message ?? e}`);
    return null;
  }
}
