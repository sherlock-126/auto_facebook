# Plan: Lead Detection + Pipeline (Phase 1, Slice 1)

Date: 2026-05-18
Status: Pending review

## Goal

Turn `fact_group_post` rows into actionable sales leads:
1. Auto-classify each new post with intent ("hỏi giá" / "tâm sự" / "spam" / "seeding" / ...) using Gemini API.
2. Create a `fact_lead` row for posts with commercial intent.
3. Provide a UI tab `#leads` to view, filter, change pipeline stage, add notes.
4. Build foundation for future multi-tenant (cloud SaaS) — add `tenant_id` everywhere now.

## Out of scope (deferred)

| Feature | Deferred to |
|---|---|
| Kanban drag/drop | Slice 2 — use stage dropdown for now |
| Multi-user / sale assignment | Slice 2 — single-user, anyone can update |
| Telegram bot alerts | Slice 3 |
| Seeding filter (whitelist/blacklist authors) | Slice 4 — Gemini already tags "seeding" intent |
| Comment-level classification | Future — posts only for now |
| Cloud SaaS migration (Path B) | Q2 |

## Architecture decisions

### Why Gemini (not OpenAI / Claude)

- **Cost**: gemini-2.5-flash $0.075/1M in + $0.30/1M out — ~10× cheaper than gpt-4o-mini, ~30× cheaper than Claude Haiku.
- **Vietnamese**: Gemini handles Vietnamese well — Google trained on massive Vietnamese web corpus.
- **JSON structured output**: native `responseMimeType: 'application/json'` + `responseSchema` — no fragile prompt-engineering for JSON.
- **Rate limits**: free tier 15 RPM / 1M tokens/day = enough for 1 customer testing; paid tier $200/M tokens — for 1000 leads/day still ~$0.10/day.

### Why a separate `fact_lead` table (not just `intent` column on `fact_group_post`)

- 1 post can have multiple "lead lifecycles" if customer re-engages months later (uncommon but possible)
- Pipeline stages + history need own table for audit
- Easier to add `assigned_to`, `sla_due_at`, `priority` later without bloating fact_group_post
- `fact_group_post` stays scrape-pure; sales workflow is downstream concern

### Why `tenant_id` now (single tenant 'default')

- Multi-tenant migration (Path B) requires `tenant_id` on every row + RLS
- Adding now = 5 minutes; adding later = painful retroactive update of every query
- Default `'default'` is invisible to current single-tenant deployment

## Schema changes (sql/002_leads.sql)

```sql
-- 1. Add tenant_id to existing tables (forward-compatible for Path B)
ALTER TABLE dim_group              ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE dim_user               ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE fact_group_post        ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE fact_group_post_comment ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_dim_group_tenant ON dim_group (tenant_id);
CREATE INDEX IF NOT EXISTS idx_fact_post_tenant ON fact_group_post (tenant_id, created_time DESC);

-- 2. Lead pipeline
CREATE TABLE IF NOT EXISTS fact_lead (
  lead_id              BIGSERIAL PRIMARY KEY,
  tenant_id            TEXT NOT NULL DEFAULT 'default',
  post_id              TEXT NOT NULL REFERENCES fact_group_post(post_id) ON DELETE CASCADE,
  group_id             TEXT REFERENCES dim_group(group_id),
  author_id            TEXT,

  -- Classification (filled by Gemini)
  intent               TEXT,                -- enum: request_quote|question|complaint|showcase|spam|seeding|other
  intent_confidence    NUMERIC,             -- 0.0 - 1.0
  intent_reason        TEXT,                -- short Vietnamese reason from LLM
  intent_entities      JSONB,               -- { product?, price_mentioned?, contact?, urgency? }
  classified_at        TIMESTAMPTZ,

  -- Pipeline state
  stage                TEXT NOT NULL DEFAULT 'new',
  stage_changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_to          TEXT,                -- user_id when multi-user lands
  note                 TEXT,                -- current free-form note (last value)

  -- Audit
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (post_id)                          -- 1 lead per post (idempotent)
);
CREATE INDEX IF NOT EXISTS idx_lead_tenant_stage     ON fact_lead (tenant_id, stage, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_intent           ON fact_lead (intent, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_unclassified     ON fact_lead (classified_at) WHERE classified_at IS NULL;

-- 3. Activity log per lead (stage changes, notes, assignments)
CREATE TABLE IF NOT EXISTS lead_history (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES fact_lead(lead_id) ON DELETE CASCADE,
  action      TEXT NOT NULL,               -- 'stage_changed'|'note_added'|'assigned'|'classified'|'created'
  from_value  TEXT,
  to_value    TEXT,
  note        TEXT,
  actor       TEXT,                        -- 'system' for auto, user_id when multi-user
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history (lead_id, created_at DESC);

-- 4. Classifier cache (avoid re-classifying same message across multiple posts)
CREATE TABLE IF NOT EXISTS lead_classifier_cache (
  msg_hash       TEXT PRIMARY KEY,         -- sha256(message)
  intent         TEXT,
  confidence     NUMERIC,
  reason         TEXT,
  entities       JSONB,
  model          TEXT,                     -- e.g. 'gemini-2.5-flash'
  cached_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Stage enum (10 + 2 terminal)

| Code | Vietnamese | Description |
|---|---|---|
| `new` | Chưa tiếp cận | Default sau khi tạo lead |
| `contacted` | Đã liên hệ | Sale đã chat/comment lần đầu |
| `info_sent` | Đã gửi thông tin | Đã gửi catalog/giá |
| `negotiating` | Đang deal giá | Đang thương lượng |
| `sample_sent` | Đã gửi mẫu | Đã ship sample |
| `awaiting_reply` | Chờ phản hồi | Chờ khách phản hồi |
| `topup_1` | Topup lần 01 | Khách nạp tiền lần 1 |
| `first_order` | Lên đơn đầu | Đơn đầu tiên |
| `topup_2` | Topup lần 02 | Khách nạp tiền lần 2 |
| `shipped_sg` | Chuyển SG | Đã ship Sài Gòn |
| `closed_won` | Chốt thành công (terminal) | Lead đã chốt |
| `closed_lost` | Mất lead (terminal) | Khách từ chối / không phản hồi |

### Intent enum

| Code | When to flag as lead? |
|---|---|
| `request_quote` | Hỏi giá, hỏi báo giá, hỏi inbox | ✅ Yes |
| `question` | Hỏi sản phẩm chung chung | ✅ Yes |
| `complaint` | Phàn nàn về sản phẩm/dịch vụ | ✅ Yes (cơ hội recover) |
| `showcase` | Khoe ảnh / kết quả dùng sản phẩm | ⚠️ No (chỉ tracking) |
| `spam` | Quảng cáo người khác | ❌ No |
| `seeding` | Bài seeding (template, lặp lại nhiều group) | ❌ No |
| `other` | Tâm sự, off-topic, vô thưởng vô phạt | ❌ No |

→ Lead chỉ tạo nếu `intent ∈ {request_quote, question, complaint}`. Còn lại classify nhưng skip lead.

## Code structure

### New files

```
src/leads/
├─ classifier.ts          Gemini API wrapper + cache lookup
├─ detector.ts            Hook called from fb_group_post entity
└─ pipeline.ts            Stage enum, validation, helpers

sql/002_leads.sql         Migration

docs/PLAN_LEADS.md        This file
```

### Modified files

```
src/etl/entities/fb_group_post.ts
  - After upsertBatch posts → for each newly inserted/updated post:
    call leads/detector.maybeCreateLead(post)
    (async, non-blocking — don't fail scrape if classifier fails)

src/server.ts
  - Add endpoints: /api/leads/*
  - Add tab #leads in sidebar
  - Add UI view: list + detail slide-in

.env.example (new file)
  - GEMINI_API_KEY=...
  - GEMINI_MODEL=gemini-2.5-flash  (override)
  - CLASSIFIER_ENABLED=true        (master switch)
```

### Classifier interface

```typescript
// src/leads/classifier.ts
export interface ClassifyResult {
  intent: 'request_quote' | 'question' | 'complaint' | 'showcase' | 'spam' | 'seeding' | 'other';
  confidence: number;        // 0-1
  reason: string;            // 1 sentence Vietnamese
  entities: {
    product?: string;
    price_mentioned?: string;
    contact_mentioned?: string;   // phone/Zalo/IB visible in post
    urgency?: 'low' | 'medium' | 'high';
  };
}

export async function classifyMessage(message: string, ctx?: { group_name?: string }): Promise<ClassifyResult | null>;
```

### Detector interface

```typescript
// src/leads/detector.ts
export async function maybeCreateLead(post: {
  post_id: string;
  group_id: string;
  author_id: string | null;
  message: string | null;
  tenant_id?: string;
}): Promise<void>;
// idempotent: if lead exists for post_id, skip
// async: fire-and-forget from caller; logs errors don't break ETL
```

## Gemini prompt (v1, will iterate)

```text
Bạn là AI phân loại bài viết Facebook group thương mại. Phân tích bài sau:

Bài viết:
"""{message}"""

Group: {group_name}

Trả về JSON theo schema:
{
  "intent": "request_quote" | "question" | "complaint" | "showcase" | "spam" | "seeding" | "other",
  "confidence": <0-1>,
  "reason": "<1 câu tiếng Việt giải thích>",
  "entities": {
    "product": "<sản phẩm khách quan tâm, nếu có>",
    "price_mentioned": "<giá khách nhắc đến, nếu có>",
    "contact_mentioned": "<sđt/zalo/ib khách để lại, nếu có>",
    "urgency": "low" | "medium" | "high"
  }
}

Quy tắc:
- "request_quote": khách hỏi giá, hỏi báo giá, "ib mình giá", "có sản phẩm X không"
- "question": hỏi cách dùng, hỏi tư vấn (chưa rõ ý mua)
- "complaint": phàn nàn sản phẩm/dịch vụ
- "showcase": khoe ảnh dùng sản phẩm, kết quả
- "spam": bài quảng cáo công ty khác
- "seeding": template kêu gọi like/share, content lặp lại
- "other": tâm sự, off-topic
```

## API endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/leads` | `?stage=&intent=&group_id=&q=&limit=` | `{ rows, totals, paging }` |
| GET | `/api/leads/:id` | — | `{ lead, post, group, comments, history }` |
| PATCH | `/api/leads/:id` | `{ stage?, note?, assigned_to? }` | `{ ok }` — also writes history row |
| POST | `/api/leads/:id/note` | `{ note }` | `{ ok, history_id }` |
| POST | `/api/leads/classify-backfill` | `{ limit?: 100, force?: false }` | `{ classified, errors }` — runs classifier on posts not yet classified |
| GET | `/api/leads/stats` | — | `{ counts_by_stage, counts_by_intent, recent_24h }` |

## UI changes

### Sidebar
Add `🎯 Leads` between Posts and Comments.

### View `#leads`
```
┌─ 🎯 Leads ─────────────────────────────────────────────────┐
│ Filter: [stage ▼] [intent ▼] [group ▼] [q______] [reload]   │
│                                                              │
│ Stats: 12 new | 5 contacted | 3 negotiating | ... | 18 won  │
│                                                              │
│ ┌─ table ──────────────────────────────────────────────────┐│
│ │ time     │ author    │ group       │ intent    │ stage   ││
│ ├──────────┼───────────┼─────────────┼───────────┼─────────┤│
│ │ 2h trước │ Anh A     │ Spa VN      │ hỏi giá🔥 │ new ▼   ││
│ │ 5h trước │ Chị B     │ Mẹ bé       │ question  │ contac ▼││
│ │ ...                                                       ││
│ └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Detail slide-in (click row)
- Full post message
- Classification: intent + reason + confidence + entities
- Stage dropdown (12 options) — change → POST PATCH + log history
- Note textarea + "Add note" button
- History timeline (created → classified → stage_changed → notes...)
- Link to original post on FB
- Embedded comments của post

## Cost estimate

### Gemini API per month (assuming 1000 posts/day for 1 customer)

- Avg post ≈ 300 token input + 100 token output
- 1000 posts × 30 days = 30k posts/month
- Input: 30k × 300 = 9M tokens × $0.075/1M = **$0.68/month**
- Output: 30k × 100 = 3M tokens × $0.30/1M = **$0.90/month**
- **Total: $1.58/month/customer** at high volume

With sha256 cache hit ratio of ~30% (similar seeding/template posts): ~**$1.10/month**.

Negligible cost.

### Time to implement

| Task | Estimate |
|---|---|
| Schema migration | 15 min |
| Classifier module | 30 min |
| Detector hook | 15 min |
| API endpoints | 45 min |
| UI tab | 75 min |
| Smoke test + bugfix | 30 min |
| **Total** | **~3.5 hours** |

## Migration steps

1. Stop scheduler temporarily (to avoid race on schema change)
   `systemctl stop auto-facebook-scheduler.service`
2. Apply migration:
   `psql ... -f sql/002_leads.sql`
3. Deploy code (restart server)
   `systemctl restart auto-facebook.service`
4. Verify schema:
   - `\d fact_lead`, `\d lead_history`
   - existing tables have `tenant_id` column
5. Set Gemini key in .env:
   `GEMINI_API_KEY=AIza...`
6. Test classifier manually:
   `curl -X POST /api/leads/classify-backfill -d '{"limit": 5}'`
7. Verify leads appear in #leads tab
8. Restart scheduler:
   `systemctl start auto-facebook-scheduler.service`
9. Next tick will auto-classify new posts

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Gemini API down / quota exceeded | Medium | Classifier returns null → lead stays unclassified, retry later via backfill endpoint |
| Wrong classification (false negatives — miss real leads) | Medium | Backfill button + manual stage edit; iterate prompt |
| Schema migration breaks live ETL | Low | Use `IF NOT EXISTS` everywhere; default values for new columns; tested locally first |
| Classifier slow → blocks ETL | Low | Fire-and-forget pattern, classifier failures don't block upsert |
| Gemini changes JSON format | Low | Wrap parse in try/catch + log raw response; pin model version |

## Testing plan

### Manual smoke test (after implementation)

1. **Schema check**: 
   ```sql
   SELECT column_name FROM information_schema.columns WHERE table_name='dim_group' AND column_name='tenant_id';
   SELECT * FROM fact_lead LIMIT 0;
   ```
2. **Classifier unit test**: 
   ```bash
   curl -X POST http://127.0.0.1:4200/api/leads/classify-backfill -H 'content-type: application/json' -d '{"limit": 3}'
   ```
   Expect: 3 leads created with intent fields populated.
3. **End-to-end**: trigger fb_group_post for 1 group → check fact_lead has new rows for posts with commercial intent.
4. **UI smoke**: 
   - Open #leads → see leads
   - Filter by stage='new' → see filtered list
   - Click row → detail panel
   - Change stage → reload → confirm change persisted
   - Check `lead_history` row created
5. **Edge cases**:
   - Post with empty message → classifier returns null gracefully
   - Gemini API down → no crash, lead unclassified
   - Same message in 2 posts → cache hit on 2nd call

## User decisions (2026-05-18)

1. ✅ **Gemini API key**: provided, saved to `.env` as `GEMINI_API_KEY`.
2. ✅ **Stage names**: keep as designed (12 stages).
3. ✅ **Auto-create lead = per-tenant config**: add `tenant_settings` table with JSONB column `lead_intents` (default `['request_quote','question','complaint']`). Slice 2 will add UI; for now editable via `PATCH /api/settings`.
4. ✅ **Comment classification deferred to slice 2.**

## Additional schema for tenant config

```sql
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id     TEXT PRIMARY KEY,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Default config for the single tenant
INSERT INTO tenant_settings (tenant_id, config) VALUES (
  'default',
  '{"lead_intents": ["request_quote","question","complaint"], "classifier_enabled": true, "classifier_model": "gemini-2.5-flash"}'
) ON CONFLICT (tenant_id) DO NOTHING;
```

Config schema (TypeScript type):
```ts
interface TenantConfig {
  lead_intents: Array<'request_quote'|'question'|'complaint'|'showcase'|'spam'|'seeding'|'other'>;
  classifier_enabled: boolean;
  classifier_model: string;  // gemini-2.5-flash | gemini-2.5-pro
}
```

API:
- `GET /api/settings` → returns config for current tenant
- `PATCH /api/settings` → merges partial config into JSONB
