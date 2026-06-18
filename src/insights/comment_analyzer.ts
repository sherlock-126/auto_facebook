/**
 * Weekly comment analysis pipeline.
 *
 * For each tenant: pull comments from the last 7 days, bucket by category
 * (HR / Fulfill / Other) using keyword routing (same logic as Telegram topic
 * routing), then have Gemini summarize themes per category.
 *
 * Output rows in `comment_insights`; UI's Insights tab reads from there.
 */
import { pool } from '../db.js';
import { logGeminiUsage } from '../leads/gemini_usage.js';

interface Bucket {
  category: 'hr' | 'fulfill' | 'other';
  total: number;
  top_commenters: { author_id: string; name: string; profile: string | null; n_comments: number }[];
  hot_threads:    { post_id: string; msg_preview: string; n_comments: number }[];
  sample_comments: { author_name: string; message: string; post_id: string }[];
}

function categorize(text: string): 'hr' | 'fulfill' | 'other' {
  const t = (text || '').toLowerCase();
  if (/tuyển|recruit|hiring|designer|seller|nhân viên|\bhr\b/.test(t)) return 'hr';
  if (/fulfill|supplier|\bsup\b|xưởng|cung cấp|\bff\b|nhà cung|báo giá|basecost/.test(t)) return 'fulfill';
  return 'other';
}

interface EnrichedComment {
  author_name: string;
  author_profile: string | null;
  message: string;
}

interface BucketContext {
  totalComments: number;
  topCommenters: { name: string; profile: string | null; n: number }[];
  // Comments that include contact info (sđt/zalo/inbox) — proxy for competitor solicitations
  contactComments: EnrichedComment[];
  // Comments mentioning prices (numbers + đ/k/usd/$)
  priceComments: EnrichedComment[];
  // Hot threads (post previews + counts) — what kind of products people ask about
  hotThreadPreviews: { preview: string; n: number }[];
}

async function geminiSummary(category: 'hr' | 'fulfill' | 'other', enriched: EnrichedComment[], ctx: BucketContext, tenantId: string): Promise<string> {
  // Per-tenant key: prefer customer's own key, fall back to system shared.
  const { getTenantConfig } = await import('../leads/pipeline.js');
  const tcfg = await getTenantConfig(tenantId);
  const apiKey = (tcfg.gemini_api_key && tcfg.gemini_api_key.trim()) || process.env.GEMINI_API_KEY;
  if (!apiKey || enriched.length === 0) return JSON.stringify({ error: 'no_data' });
  const catLabel = category === 'hr' ? 'tuyển dụng (HR)' : 'fulfill/supplier';

  const competitors = ctx.contactComments.slice(0, 25);
  const prompt = [
    `Bạn là analyst cho shop POD phonecase/airpods VN.`,
    `Phân tích ${ctx.totalComments} comment groups POD tuần qua, chủ đề "${catLabel}".`,
    ``,
    `=== TOP COMMENTERS ===`,
    ctx.topCommenters.slice(0, 10).map((c, i) => `${i + 1}. ${c.name}${c.profile ? ` | ${c.profile}` : ''} | ${c.n} cmts`).join('\n'),
    ``,
    `=== HOT THREADS (post nhiều comment) ===`,
    ctx.hotThreadPreviews.slice(0, 8).map((t, i) => `${i + 1}. "${t.preview}" | ${t.n} cmts`).join('\n'),
    ``,
    `=== ${ctx.contactComments.length} COMMENTS CÓ CONTACT INFO (likely đối thủ) ===`,
    competitors.map((c, i) => `[${i + 1}] ${c.author_name}${c.author_profile ? ` | ${c.author_profile}` : ''}: "${c.message.replace(/\n+/g, ' ').slice(0, 350)}"`).join('\n'),
    ``,
    `=== ${ctx.priceComments.length} COMMENTS MENTION GIÁ ===`,
    ctx.priceComments.slice(0, 20).map((c, i) => `[${i + 1}] ${c.author_name}: "${c.message.replace(/\n+/g, ' ').slice(0, 300)}"`).join('\n'),
    ``,
    `=== SAMPLE KHÁC (${Math.min(enriched.length, 25)} cái) ===`,
    enriched.slice(0, 25).map((c, i) => `[${i + 1}] ${c.author_name}: "${c.message.replace(/\n+/g, ' ').slice(0, 200)}"`).join('\n'),
  ].join('\n');

  const schema = {
    type: 'object',
    properties: {
      headline:     { type: 'string', description: '1 câu insight quan trọng nhất tuần này (max 100 chars, dạng tweet — số + action).' },
      stats: {
        type: 'object',
        properties: {
          total_comments:    { type: 'integer' },
          contact_rate_pct:  { type: 'integer', description: '% comments có contact info (0-100)' },
          price_rate_pct:    { type: 'integer', description: '% comments mention giá (0-100)' },
          unique_competitors:{ type: 'integer', description: 'số đối thủ unique đếm được từ contact comments' },
        },
        required: ['total_comments', 'contact_rate_pct', 'price_rate_pct', 'unique_competitors'],
      },
      competitors: {
        type: 'array',
        description: 'Top 5 đối thủ (commenter có contact info). Tên + profile + dịch vụ họ chào (1 câu ngắn).',
        items: {
          type: 'object',
          properties: {
            name:    { type: 'string' },
            profile: { type: 'string', description: 'FB profile URL hoặc empty' },
            offers:  { type: 'string', description: '1 câu (max 80 chars) — họ chào gì' },
            evidence:{ type: 'string', description: 'Quote 1 câu (max 120 chars) chứng minh' },
          },
          required: ['name', 'offers'],
        },
      },
      prices: {
        type: 'array',
        description: 'Top 5 mức giá cụ thể trích từ comments. Phải có con số.',
        items: {
          type: 'object',
          properties: {
            item:  { type: 'string', description: 'Sản phẩm/dịch vụ (vd "TikTok ship 60k", "Designer POD lương")' },
            price: { type: 'string', description: 'Mức giá CỤ THỂ (vd "60k/đơn", "8-12tr/tháng", "$13.75")' },
            from:  { type: 'string', description: 'Tên FB người báo giá' },
          },
          required: ['item', 'price'],
        },
      },
      hot_products: {
        type: 'array',
        description: 'Top 3-5 sản phẩm khách hỏi nhiều tuần này (tên ngắn).',
        items: {
          type: 'object',
          properties: {
            name:    { type: 'string' },
            n_signal:{ type: 'integer', description: 'Ước số lượng đề cập (1-100)' },
          },
          required: ['name'],
        },
      },
      actions: {
        type: 'array',
        description: '3 hành động cụ thể cho shop. Mỗi action ngắn + lý do từ data.',
        items: {
          type: 'object',
          properties: {
            title:    { type: 'string', description: 'Action (max 60 chars)' },
            why:      { type: 'string', description: 'Lý do, có dẫn chứng cụ thể từ data (max 150 chars)' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['title', 'why'],
        },
      },
    },
    required: ['headline', 'stats', 'competitors', 'prices', 'hot_products', 'actions'],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8000,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: 'application/json',
            responseSchema: schema,
          },
        }),
        signal: ctrl.signal,
      }
    );
    const j: any = await res.json();
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    void logGeminiUsage(tenantId, model, `comment_analyzer:${category}`, j?.usageMetadata, true);
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const finish = j?.candidates?.[0]?.finishReason ?? 'unknown';
      return JSON.stringify({ error: 'gemini_no_response', finish_reason: finish });
    }
    // Sanity-parse (Gemini sometimes still wraps in ```json)
    try { JSON.parse(text); return text; }
    catch { return JSON.stringify({ error: 'gemini_invalid_json', raw: text.slice(0, 500) }); }
  } catch (e: any) {
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    void logGeminiUsage(tenantId, model, `comment_analyzer:${category}`, null, false, String(e?.message ?? e).slice(0, 300));
    return JSON.stringify({ error: 'gemini_error', message: e?.message ?? String(e) });
  } finally { clearTimeout(timer); }
}

/** Run the analysis for one tenant. Returns count of buckets written. */
export async function runCommentInsights(tenantId: string, weekStart?: Date): Promise<number> {
  // Default = Monday of current ISO week (so multiple runs same week UPSERT)
  const start = weekStart ?? (() => {
    const d = new Date();
    const dow = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - dow);
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const startIso = start.toISOString().slice(0, 10);
  const endIso   = new Date(start.getTime() + 7 * 86400_000).toISOString().slice(0, 10);

  // Pull all comments in the window for the tenant (with author + post context).
  const { rows: comments } = await pool.query(
    `SELECT c.comment_id, c.author_id, c.post_id, c.message, c.created_time, c.reaction_count,
            c.raw->'author'->>'name' AS author_name,
            c.raw->'author'->>'url'  AS author_profile,
            substr(p.message, 1, 120) AS post_preview
       FROM fact_group_post_comment c
       LEFT JOIN fact_group_post p USING (post_id)
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
        AND c.created_time >= $2::date AND c.created_time < $3::date
        AND c.message IS NOT NULL AND length(c.message) > 8`,
    [tenantId, startIso, endIso]
  );

  // Bucket
  const buckets: Record<string, Bucket> = {
    hr:      { category: 'hr',      total: 0, top_commenters: [], hot_threads: [], sample_comments: [] },
    fulfill: { category: 'fulfill', total: 0, top_commenters: [], hot_threads: [], sample_comments: [] },
    other:   { category: 'other',   total: 0, top_commenters: [], hot_threads: [], sample_comments: [] },
  };
  const commenterCounts: Record<string, Record<string, { name: string; profile: string | null; n: number }>> = { hr: {}, fulfill: {}, other: {} };
  const threadCounts:    Record<string, Record<string, { preview: string; n: number }>>                       = { hr: {}, fulfill: {}, other: {} };
  const enrichedSamples: Record<string, EnrichedComment[]>     = { hr: [], fulfill: [], other: [] };
  const contactSamples:  Record<string, EnrichedComment[]>     = { hr: [], fulfill: [], other: [] };
  const priceSamples:    Record<string, EnrichedComment[]>     = { hr: [], fulfill: [], other: [] };

  const reContact = /(zalo|sđt|\bib\b|inbox|\b09\d{8}\b|\b08\d{8}\b|\b07\d{8}\b|m\.me|t\.me|telegram|\bdm\b|messenger)/i;
  const rePrice   = /(\d[\d.,]*\s*(k|nghìn|tr|triệu|đ|usd|\$|usd\/|\/đơn|\/sp))|basecost|báo giá|price\b/i;

  for (const c of comments) {
    const cat = categorize(c.message + ' ' + (c.post_preview ?? ''));
    buckets[cat].total++;
    const uid = String(c.author_id ?? 'anon');
    const name = c.author_name ?? uid;
    const profile = c.author_profile ?? null;
    // Commenter aggregation
    const cm = commenterCounts[cat][uid] ?? { name, profile, n: 0 };
    cm.n++;
    commenterCounts[cat][uid] = cm;
    // Thread aggregation
    const pid = String(c.post_id);
    const th = threadCounts[cat][pid] ?? { preview: c.post_preview ?? '(no preview)', n: 0 };
    th.n++;
    threadCounts[cat][pid] = th;
    // Sample for Gemini
    const enr: EnrichedComment = { author_name: name, author_profile: profile, message: c.message };
    if (enrichedSamples[cat].length < 100) enrichedSamples[cat].push(enr);
    if (reContact.test(c.message) && contactSamples[cat].length < 40) contactSamples[cat].push(enr);
    if (rePrice.test(c.message)   && priceSamples[cat].length   < 30) priceSamples[cat].push(enr);
    if (buckets[cat].sample_comments.length < 5) {
      buckets[cat].sample_comments.push({ author_name: name, message: c.message.slice(0, 200), post_id: pid });
    }
  }

  // Finalize top lists per bucket
  for (const cat of ['hr', 'fulfill', 'other'] as const) {
    buckets[cat].top_commenters = Object.entries(commenterCounts[cat])
      .map(([id, v]) => ({ author_id: id, name: v.name, profile: v.profile, n_comments: v.n }))
      .sort((a, b) => b.n_comments - a.n_comments).slice(0, 10);
    buckets[cat].hot_threads = Object.entries(threadCounts[cat])
      .map(([post_id, v]) => ({ post_id, msg_preview: v.preview, n_comments: v.n }))
      .sort((a, b) => b.n_comments - a.n_comments).slice(0, 5);
  }

  // Build context per bucket
  function mkCtx(cat: 'hr' | 'fulfill'): BucketContext {
    return {
      totalComments:     buckets[cat].total,
      topCommenters:     buckets[cat].top_commenters.map(c => ({ name: c.name, profile: c.profile, n: c.n_comments })),
      contactComments:   contactSamples[cat],
      priceComments:     priceSamples[cat],
      hotThreadPreviews: buckets[cat].hot_threads.map(t => ({ preview: t.msg_preview, n: t.n_comments })),
    };
  }
  // Gemini summaries (parallel, HR + Fulfill only — other is too noisy)
  const [hrSum, ffSum] = await Promise.all([
    buckets.hr.total      >= 5 ? geminiSummary('hr',      enrichedSamples.hr,      mkCtx('hr'),      tenantId) : Promise.resolve('(không đủ data — cần ≥5 comments)'),
    buckets.fulfill.total >= 5 ? geminiSummary('fulfill', enrichedSamples.fulfill, mkCtx('fulfill'), tenantId) : Promise.resolve('(không đủ data — cần ≥5 comments)'),
  ]);

  // UPSERT each bucket
  const summaries: Record<string, string> = { hr: hrSum, fulfill: ffSum, other: '(skip — không phân tích bucket "other")' };
  let n = 0;
  for (const cat of ['hr', 'fulfill', 'other'] as const) {
    const b = buckets[cat];
    await pool.query(
      `INSERT INTO comment_insights (tenant_id, week_start, category, total_comments, top_commenters, hot_threads, gemini_summary)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (tenant_id, week_start, category) DO UPDATE
         SET total_comments = EXCLUDED.total_comments,
             top_commenters = EXCLUDED.top_commenters,
             hot_threads    = EXCLUDED.hot_threads,
             gemini_summary = EXCLUDED.gemini_summary,
             generated_at   = now()`,
      [tenantId, startIso, cat, b.total, JSON.stringify(b.top_commenters), JSON.stringify(b.hot_threads), summaries[cat]]
    );
    n++;
  }
  return n;
}

/** Run for all tenants that have any comments. Used by weekly cron. */
export async function runWeeklyInsightsAllTenants(): Promise<{ tenant_id: string; ok: boolean; err?: string }[]> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM fact_group_post_comment WHERE tenant_id IS NOT NULL`
  );
  const out: { tenant_id: string; ok: boolean; err?: string }[] = [];
  for (const r of rows) {
    try { await runCommentInsights(r.tenant_id); out.push({ tenant_id: r.tenant_id, ok: true }); }
    catch (e: any) { out.push({ tenant_id: r.tenant_id, ok: false, err: e?.message ?? String(e) }); }
  }
  return out;
}
