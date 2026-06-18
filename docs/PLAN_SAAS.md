# Plan: Path B — Hybrid SaaS (multi-tenant cloud + customer agent)

Date: 2026-05-18
Status: Pending review
Companion to: [PLAN_LEADS.md](./PLAN_LEADS.md)

## 1. Goal

Migrate `auto_facebook` từ **single-VPS monolith** (như `dev-fb.autonow.vn` đang chạy) sang **multi-tenant SaaS** where:

- **Cloud** (`fb.autonow.vn` — VPS của anh) hosts ALL UI, leads, classifier, billing for every customer.
- **Customer VPS** hosts ONLY a thin agent (Chrome + scraper) — runs 24/7, outbound-only, no domain needed.
- One install command, 3-minute onboarding for customer.
- FB cookies/IndexedDB **never leave** customer VPS → privacy + compliance + per-customer fingerprint isolation.

## 2. Out of scope (deferred to later phases)

| Feature | Defer to |
|---|---|
| Write actions (auto-post / auto-comment) via cloud-pushed jobs | Phase D — sau khi anh confirm Phase A+B+C ổn |
| Stripe/PayOS billing integration | Phase E — manual license keys cho đến khi MVP có 5+ paying customers |
| Multi-platform (TikTok, Instagram, Zalo) | Q3-Q4 |
| Mobile app (iOS/Android) | Q4+ |
| Custom branding per tenant (white-label) | After product-market fit |
| MCP tools for AI agents | Phase F |

## 3. Architecture target

```
┌─────────────────── CLOUD (fb.autonow.vn — VPS anh) ─────────────────────┐
│                                                                          │
│ Web UI (Next.js or Fastify+vanilla)                                      │
│ ├─ /signup, /login (Clerk auth)                                          │
│ ├─ /dashboard      — KPIs per tenant                                     │
│ ├─ /agent          — agent status + onboarding instructions              │
│ ├─ /groups         — manage enabled groups                               │
│ ├─ /posts /comments /leads — existing UI, per-tenant filter              │
│ ├─ /settings       — Gemini key (optional), lead intents                 │
│ └─ /login-fb       — embeds reverse-tunneled noVNC from customer agent   │
│                                                                          │
│ API + WSS Gateway (Fastify + ws)                                         │
│ ├─ /api/auth/*     — Clerk webhook integration                           │
│ ├─ /api/leads/*    /api/groups/* etc. (existing, + tenant filter)        │
│ ├─ /api/agent/*    — push jobs, query agent state                        │
│ ├─ WSS /agent      — agent connects with license_key                     │
│ └─ WSS /vnc/:tid   — reverse-tunneled noVNC stream to customer agent     │
│                                                                          │
│ Job Dispatcher (Postgres queue OR BullMQ+Redis if scaling)               │
│ ├─ Cron: per-tenant, every 2h, enqueue scrape_posts + scrape_comments    │
│ └─ Push job → agent's WSS connection → wait result                       │
│                                                                          │
│ Postgres (multi-tenant, RLS)                                             │
│ ├─ tenants, users, agent_connections                                     │
│ ├─ dim_group, fact_group_post, fact_lead, ...  (all with tenant_id)      │
│ └─ Gemini classifier cache (shared across tenants — same template = same │
│    classification, no per-tenant leakage of message content)             │
│                                                                          │
│ Lead classifier (Gemini)                                                 │
│ ├─ Default key from anh (shared) — included in subscription              │
│ └─ Per-tenant key override (customer types in Settings, uses their key)  │
│                                                                          │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           │  ALL outbound from agent
                           │  WSS connection (auth: license_key)
                           │  Reconnect on disconnect
                           ▼
┌────────────────── CUSTOMER VPS (~$5/month, anywhere) ───────────────────┐
│                                                                          │
│ Docker compose (single `docker-compose.yml`):                            │
│   - chrome      Xvfb :201 + Chrome persistent profile + websockify       │
│   - agent       Node TS daemon (WSS client to cloud)                     │
│   - postgres    LOCAL Postgres: storage_state, fb_session, run history   │
│                 (chỉ cache + session, KHÔNG chứa scraped data)           │
│                                                                          │
│ Outbound only — KHÔNG cần:                                              │
│   ❌ Domain                                                              │
│   ❌ Cloudflare tunnel                                                   │
│   ❌ Public IP                                                           │
│   ❌ Port forward                                                        │
│   ✅ Chỉ HTTPS outbound (port 443 ra fb.autonow.vn)                     │
│                                                                          │
│ Agent state machine:                                                     │
│   1. Connect WSS → cloud verify license → "ready"                       │
│   2. Receive job → execute (browser scrape) → return result via WSS      │
│   3. Heartbeat every 30s → cloud track "last_seen"                       │
│   4. On Chrome crash / FB session revoke → notify cloud → cloud alert    │
│                                                                          │
│ FB session cookies STORED LOCALLY:                                       │
│   - `data/chrome-profile/` (Chrome profile, persistent)                  │
│   - `postgres.fb_session` (storage_state JSON backup)                    │
│   - NEVER sent to cloud                                                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. Migration path (from current state)

```
NOW: monolith
  dev-fb.autonow.vn = single tenant ('default')
  app + Chrome + PG + cloudflared all on 1 VPS
  
↓ Phase A (~2 tuần)
  
fb.autonow.vn = multi-tenant UI
  Same VPS but multi-tenant
  Auth, signup, per-tenant data isolation
  Anh's own data → tenant_id='tuantran' (migrated)
  But Chrome still on this VPS — no agent yet
  Beta customer (vd 1-2 người) login fb.autonow.vn, dùng anh's Chrome (chia sẻ)
  → Validates UI multi-tenant flow
  
↓ Phase B (~3 tuần)
  
Agent split
  - Code agent thành standalone TS daemon
  - WSS protocol cloud ↔ agent
  - Customer 1st VPS spin up agent
  - Tenant 'tuantran' chuyển từ "shared cloud Chrome" → agent của riêng anh
  
↓ Phase C (~1 tuần)
  
Installer
  - `curl install.sh | bash` flow
  - License key system
  - Customer onboarding wizard
  - Production ready for 10-100 customer
```

## 5. Phase A — Multi-tenant UI (1.5-2 tuần)

### A.1. Auth integration (email/password + Resend)

**Stack:**
- `bcrypt` cho password hashing (cost factor 12)
- `jose` cho JWT (sign + verify)
- `resend` SDK cho transactional email
- httpOnly cookie chứa JWT (12h TTL, sliding refresh on activity)
- `@fastify/rate-limit` chống brute-force (5 req/min/IP trên `/auth/*`)

**Flow:**

```
SIGNUP:
  POST /auth/signup { email, password, tenant_name }
    → bcrypt hash → insert users + tenants rows
    → generate verification token (32 bytes random, 24h TTL)
    → Resend email "Xác thực email" với link fb.autonow.vn/verify?t=...
    → return { ok: true, email_sent: true }

VERIFY:
  GET /verify?t=xxx
    → lookup email_verification_tokens
    → set users.email_verified_at = now()
    → delete token
    → redirect /login

LOGIN:
  POST /auth/login { email, password }
    → bcrypt compare → check email_verified_at NOT NULL
    → sign JWT { sub: user_id, tid: tenant_id, role }
    → set httpOnly cookie 'sid' (12h)
    → return { ok: true }

MIDDLEWARE:
  Every API request:
    → read 'sid' cookie → verify JWT
    → load tenant_id into req
    → SET LOCAL app.tenant_id = $1 (for RLS)

FORGOT PASSWORD:
  POST /auth/forgot { email }
    → generate reset token (32 bytes, 1h TTL)
    → Resend email với link /reset?t=...
  POST /auth/reset { token, new_password }
    → validate token, hash new password, delete token

LOGOUT:
  POST /auth/logout → clear cookie
```

**Implementation:**

```typescript
// src/auth/middleware.ts
import { jwtVerify } from 'jose';
import { pool } from '../db.js';

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET!);

export async function authMiddleware(req, reply) {
  const sid = req.cookies?.sid;
  if (!sid) return reply.status(401).send({ error: 'No session' });
  try {
    const { payload } = await jwtVerify(sid, SECRET);
    req.user_id = payload.sub;
    req.tenant_id = payload.tid as string;
    req.role = payload.role as string;
    // Set RLS context for this connection
    await pool.query('SET LOCAL app.tenant_id = $1', [req.tenant_id]);
  } catch {
    return reply.status(401).send({ error: 'Invalid session' });
  }
}
```

**Email templates (inline HTML in TS):**
- `verify.ts` — "Xác thực email" với button click → /verify?t=xxx
- `reset.ts` — "Đặt lại mật khẩu" với button → /reset?t=xxx
- `welcome.ts` — sau verify, "Chào mừng đến với fb.autonow.vn"

Cost: Resend free 3000 emails/month → đủ cho hundreds of customers signups + password resets.

### A.2. Database schema (multi-tenant)

```sql
-- 003_multitenant.sql

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id    TEXT PRIMARY KEY,           -- slug, eg 'acme-corp'
  name         TEXT NOT NULL,
  owner_email  TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free', -- free|pro|enterprise
  license_key  TEXT NOT NULL UNIQUE,        -- for agent auth
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ                  -- when set: agent rejected, UI read-only
);

CREATE TABLE IF NOT EXISTS users (
  auth_id      TEXT PRIMARY KEY,            -- Clerk user_id
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member', -- owner|admin|member
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_tenant ON users (tenant_id);

CREATE TABLE IF NOT EXISTS agent_connections (
  tenant_id      TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  agent_version  TEXT,
  connected_at   TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'offline', -- offline|online|stale
  metadata       JSONB                            -- VPS host info: OS, RAM, disk
);

-- Migrate existing 'default' tenant → real tenant
INSERT INTO tenants (tenant_id, name, owner_email, plan, license_key)
VALUES ('default', 'Built-in default', 'admin@autonow.vn', 'enterprise', 'INTERNAL-' || md5(random()::text))
ON CONFLICT (tenant_id) DO NOTHING;
```

### A.3. Row-level isolation

**Two options:**
- **Application-level filter** (giản đơn): every query has `WHERE tenant_id = $TENANT`. Risk: developer quên → leak.
- **Postgres RLS** (chắc chắn): `ALTER TABLE fact_lead ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON fact_lead USING (tenant_id = current_setting('app.tenant_id'));` — set `SET LOCAL app.tenant_id = $X` mỗi connection.

**Recommend RLS** vì compliance — 1 lần config, không lo nhân viên dev sau này quên filter.

### A.4. UI changes

Sidebar header thêm tenant info:
```
auto_facebook
  Phong Nguyễn · ACME Corp
  Plan: Pro · ●●●●● agent online
```

Settings page mới:
- Profile (tên, email)
- Tenant info (license_key copy button cho agent install)
- Gemini key override (input field, type='password')
- Agent connection status
- Subscription / billing (later)
- Team members (later phase)

Onboarding wizard (modal sau signup):
1. Welcome → "Cài agent trên VPS của bạn"
2. Copy install command:
   ```bash
   curl https://fb.autonow.vn/install.sh | bash -s LICENSE=<key>
   ```
3. Wait for agent online → "Agent connected ✓"
4. "Login Facebook" → mở reverse-tunneled noVNC trong iframe
5. "Choose groups to scrape" → list 161 group user đã join
6. Done → redirect dashboard

### A.5. Code changes (Phase A scope)

```
src/
├─ auth/
│  ├─ clerk-middleware.ts       Verify Clerk JWT + load tenant
│  └─ require-role.ts           RBAC: owner/admin/member
├─ tenant/
│  ├─ provisioning.ts           Create tenant + license_key on signup
│  └─ context.ts                AsyncLocalStorage for current tenant
├─ server.ts                    Update existing handlers to use req.tenant_id
└─ ui/
   ├─ signup.html               (or Next.js if migrate)
   ├─ login.html
   └─ onboarding.html
```

**Most queries need 1-line update:**
```typescript
// before
const { rows } = await pool.query('SELECT * FROM fact_lead WHERE ...');
// after
const { rows } = await pool.query('SELECT * FROM fact_lead WHERE tenant_id=$1 AND ...', [req.tenant_id, ...]);
```

Or with RLS:
```typescript
// Beginning of each request handler:
await pool.query('SET LOCAL app.tenant_id = $1', [req.tenant_id]);
// All subsequent queries auto-filtered by RLS
```

### A.6. Phase A deliverables

| # | Deliverable | Day estimate |
|---|---|---|
| 1 | Schema migration 003 (tenants/users/connections) + RLS policies | 1d |
| 2 | Clerk integration + auth middleware | 1d |
| 3 | Signup → tenant provisioning | 0.5d |
| 4 | Settings page (Gemini key, license display) | 0.5d |
| 5 | Update all existing endpoints with tenant filter | 1d |
| 6 | UI sidebar header + onboarding wizard | 1d |
| 7 | Migrate anh's existing data → tenant 'tuantran' | 0.5d |
| 8 | Deploy fb.autonow.vn (cloudflared tunnel cho new domain) | 0.5d |
| 9 | Smoke test với 2 fake tenant users | 0.5d |
| | **Total Phase A** | **~7 ngày** |

## 6. Phase B — Agent split (2-3 tuần)

### B.1. Repository split

Two options:
- **Monorepo** (1 git repo, `packages/cloud/` + `packages/agent/` + `packages/shared/`)
- **Separate repos** (`auto_facebook` = agent, `auto_facebook_cloud` = cloud)

**Recommend monorepo** — share types (job, result, message) easier.

### B.2. Agent code structure

```
packages/agent/
├─ src/
│  ├─ index.ts            Entry: connect WSS, register handlers
│  ├─ ws-client.ts        WebSocket client to cloud (reconnect, heartbeat)
│  ├─ job-runner.ts       Dispatch job type → handler
│  ├─ handlers/
│  │  ├─ scrape-posts.ts      (reuse src/etl/entities/fb_group_post.ts)
│  │  ├─ scrape-comments.ts
│  │  ├─ scrape-joined.ts
│  │  ├─ login-snapshot.ts    Save current FB session to local DB
│  │  └─ vnc-proxy.ts         Tunnel noVNC stream back to cloud via WSS
│  └─ fb/                 (move from src/fb/ — Chrome, session, auth)
├─ Dockerfile             Single-image: Node + Chrome + Xvfb + websockify
├─ docker-compose.yml     Compose: chrome + agent + postgres
└─ package.json
```

### B.3. Cloud ↔ Agent protocol

**Transport:** WebSocket Secure (WSS) over port 443 (= TLS, không bị NAT/firewall block).

**Message types:**

```typescript
// agent → cloud
type AgentMessage =
  | { type: 'hello',     license_key: string, agent_version: string, host_info: {...} }
  | { type: 'heartbeat', ts: number }
  | { type: 'job_result',  job_id: string, status: 'ok'|'error', data?: any, error?: string }
  | { type: 'log',         level: 'info'|'warn'|'error', msg: string }
  | { type: 'fb_status',   c_user: string|null, session_alive: boolean };

// cloud → agent
type CloudMessage =
  | { type: 'welcome',   tenant_id: string, settings: {...} }
  | { type: 'job',         job_id: string, kind: 'scrape_posts'|'scrape_comments'|..., params: any }
  | { type: 'config_update', settings: {...} }
  | { type: 'vnc_request',   stream_id: string }    // open noVNC tunnel
  | { type: 'shutdown' };                            // graceful disconnect
```

**Reliability:**
- Agent reconnects with exponential backoff (1s, 2s, 4s, ..., max 60s)
- Jobs idempotent — cloud retry on timeout (e.g. job not ack'd in 5 min)
- Heartbeat 30s — cloud marks "stale" if missing > 90s
- Job results buffered in agent local PG → sent when reconnected

### B.4. Reverse VNC tunnel

Pattern: when customer click "Login FB":
1. Cloud opens new WSS stream_id, holds open
2. Sends `{type:'vnc_request', stream_id}` to agent
3. Agent starts streaming raw bytes from websockify (port 6091) over that WSS channel
4. Cloud proxies stream to customer browser's noVNC iframe
5. When customer closes iframe → cloud sends close → agent stops streaming

```
[customer browser]  ←→  [fb.autonow.vn]  ←WSS stream→  [agent]  ←local→  [websockify :6091]
                                                                          ↓
                                                                    [x11vnc :5911]
                                                                          ↓
                                                                    [Xvfb :201]
                                                                          ↓
                                                                       [Chrome]
```

This makes Chrome screen accessible to customer without exposing customer VPS to internet.

### B.5. Phase B deliverables

| # | Deliverable | Day estimate |
|---|---|---|
| 1 | Monorepo refactor + shared types package | 1d |
| 2 | WSS server cloud-side (Fastify + ws plugin) | 1d |
| 3 | WSS client agent-side + reconnect logic | 1d |
| 4 | Job runner + handler registration | 1d |
| 5 | Migrate fb_group_post handler to agent | 1d |
| 6 | Migrate fb_group_post_comment + fb_joined_groups | 1d |
| 7 | Reverse VNC tunnel | 2d |
| 8 | Agent Docker image + compose | 1d |
| 9 | License verification on agent connect | 0.5d |
| 10 | E2E test: cloud → push job → agent execute → return result | 1d |
| 11 | Migrate anh's data to use agent (no more cloud-side Chrome) | 1d |
| | **Total Phase B** | **~12 ngày** |

## 7. Phase C — Installer + onboarding (1 tuần)

### C.1. install.sh

```bash
#!/bin/bash
# curl https://fb.autonow.vn/install.sh | bash -s LICENSE=xxx

set -e
LICENSE=${LICENSE:-$1}
[ -z "$LICENSE" ] && { echo "Missing LICENSE"; exit 1; }

# 1. Install Docker if missing
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

# 2. Pull agent compose file
mkdir -p /opt/fb-agent && cd /opt/fb-agent
curl -O https://fb.autonow.vn/agent/docker-compose.yml

# 3. Write .env
cat > .env <<EOF
LICENSE_KEY=$LICENSE
CLOUD_WSS=wss://fb.autonow.vn/agent
VNC_PASSWORD=$(openssl rand -hex 6)
EOF

# 4. Start
docker compose up -d

# 5. Wait for connection, report
sleep 5
docker compose logs agent | tail -10
echo
echo "✅ Agent started. Open https://fb.autonow.vn/dashboard to continue."
```

### C.2. Auto-update

Agent checks cloud `/api/agent/version` every hour:
- If newer image available → pull + `docker compose up -d`
- Customer doesn't need to SSH ever again

### C.3. Phase C deliverables

| # | Deliverable | Day estimate |
|---|---|---|
| 1 | `install.sh` script | 1d |
| 2 | Agent Docker image pushed to ghcr.io | 0.5d |
| 3 | Auto-update mechanism | 1d |
| 4 | Onboarding wizard (post-signup) | 1d |
| 5 | Status indicators in UI (agent online/offline, version, last_seen) | 0.5d |
| 6 | Documentation (customer-facing install guide) | 0.5d |
| 7 | Smoke test full flow: signup → install → login FB → first scrape | 1d |
| | **Total Phase C** | **~5.5 ngày** |

## 8. Tech stack decisions

| Concern | Decision | Why |
|---|---|---|
| Auth | Email/password + bcrypt + JWT cookies; Resend for transactional email | Full control, no vendor lock-in, ~$0 cost (Resend 3000 emails/mo free) |
| Frontend | Keep vanilla HTML/CSS/JS (extend current `renderApp()`) initially. Migrate to Next.js when team grows | Avoid premature complexity. Current UI works fine for MVP. |
| Backend framework | Keep Fastify | Already in use, mature |
| Job queue | Postgres-based (pg-boss or custom) initially, BullMQ+Redis when >50 tenants | Avoid Redis dep until needed |
| WebSocket | `ws` package (Fastify-compatible) | Simple, well-maintained |
| Multi-tenant isolation | Postgres RLS + app-level filter (belt & suspenders) | Defense in depth |
| Container | Docker compose for customer; PM2 or systemd for cloud | Customer cần đơn giản |
| Deployment | Cloud monolith Hetzner $20/mo VPS đến khi 100+ tenant; sau scale Kubernetes | Cost-effective start |
| Monitoring | Pino logs + Grafana Loki + UptimeRobot ping | Light, free tier |
| LLM | Gemini 2.5 Flash mặc định (anh's key); per-tenant override option | Cheap default + privacy option |

## 9. Schema migration overview

```sql
-- Phase A migration: 003_multitenant.sql
CREATE TABLE tenants (...);
CREATE TABLE users (...);
CREATE TABLE agent_connections (...);

-- Migrate 'default' tenant
INSERT INTO tenants ... ;

-- Enable RLS on all *_post / *_lead / dim_group / etc.
ALTER TABLE fact_group_post ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fact_group_post
  USING (tenant_id = current_setting('app.tenant_id', true)::text);
-- ... repeat for fact_group_post_comment, fact_lead, dim_group, ...

-- Add audit log
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  user_id       TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 10. Cost estimate

### Cloud (anh's infra)

| Item | Cost/month |
|---|---|
| VPS Hetzner CPX21 (3 vCPU, 4GB) | €5 (~$5.50) |
| Domain `autonow.vn` | $1/mo amortized |
| Cloudflare tunnel | Free |
| Clerk auth | Free (under 10k MAU) |
| Postgres on same VPS | $0 |
| Gemini API (anh paying) | ~$5 per 10 customers × avg usage |
| Backup (R2 / S3) | $1 |
| **Total** | **~$15-20/mo** untill 50+ customers |

### Per-customer (customer pays)

| Item | Cost/month |
|---|---|
| DigitalOcean $6 droplet (1vCPU, 1GB) | $6 |
| Or Vultr $3.50, Hetzner CX11 €4 | Cheaper options |
| **Customer infra** | **~$5-7/mo** |

### Pricing scenarios for anh

| Plan | Customer pays | Anh nets | Margin |
|---|---|---|---|
| Free | $0 | $0 (cost ~$0.50 for shared Gemini) | -$0.50 (CAC) |
| Pro $29/mo | $29 | ~$23 (Gemini + amortized infra) | ~80% |
| Enterprise $99/mo | $99 | ~$93 | ~94% |

**Break-even at ~5 paying Pro customers** to cover $20 cloud + dev time.

## 11. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WSS connection dropouts | Medium | Tick missed → lead trễ | Reconnect with backoff; queue jobs locally on agent; retry on cloud after timeout |
| Customer VPS chết / Chrome crash | Medium | Mất 1 tick scrape | Health check ping; alert customer via email; resume after restart |
| FB ban customer account | Medium | Customer mất data, churn | Conservative defaults (3000 req/day, 10-25s delay); disclaimer at signup |
| Tenant data leakage via RLS bug | Low | Compliance disaster | RLS enabled + double-check with app-level filter; audit log every cross-tenant access attempt |
| Anh's Gemini key abused (1 tenant heavy use) | Medium | $$$ bill | Quota per tenant (default 1000 calls/day); customer can override với own key for unlimited |
| Agent version mismatch (old agent + new cloud protocol) | High over time | Old agents break | Semver protocol negotiation in `hello` message; cloud rejects unsupported version, prompts customer to update |
| Customer doesn't know how to install Docker on Windows/Mac | Low | Can't onboard | Provide pre-baked DigitalOcean snapshot / one-click app |
| Reverse VNC tunnel laggy | Medium | Bad login UX | Compress stream, lower fps for noVNC, recommend low-latency region VPS |

## 12. URL structure — DECIDED 2026-05-18

| Layer | Decision | Why |
|---|---|---|
| **Base URL** | `fb.autonow.vn` (subdomain mới) | Branding rõ, dễ tách deploy riêng sau |
| **Tenant identification** | Single URL + session cookie | Mọi customer cùng URL `fb.autonow.vn`, login xong cookie xác định tenant. Pattern Linear/Sentry/Mixpanel. |
| **Per-customer subdomain** (vd `acme.fb.autonow.vn`) | ❌ Không cho MVP | Cần wildcard DNS + SSL + cookie domain handling. Defer đến khi có enterprise customer yêu cầu white-label |

```
Customer A login fb.autonow.vn → cookie A → tenant A data
Customer B login fb.autonow.vn → cookie B → tenant B data
Customer A & B cùng URL, dữ liệu hoàn toàn độc lập (RLS)
```

DNS setup chỉ cần 1 record:
```
fb.autonow.vn  CNAME  <cloudflare-tunnel-id>.cfargotunnel.com
```

## 13. Decisions (DECIDED 2026-05-18)

| # | Question | Decision | Notes |
|---|---|---|---|
| 1 | Domain | `fb.autonow.vn` + single URL | Section 12 |
| 2 | Auth | **Email + password**, transactional email via **Resend** | Custom auth (not Clerk). +2 days vs Clerk. Better long-term control. |
| 3 | Gemini key | **Shared** (anh's key) default. Per-tenant override available in Settings. | Onboarding friction = 0 by default. |
| 4 | FB account | Each customer logs in their own FB | Anh không cần pool accounts; customer chịu risk ban |
| 5 | Billing | **Skip MVP**. Manual `license_key` for first 5-10 customers. Add Stripe/PayOS in Phase E later. | Focus on product fit first |
| 6 | Starting point | **Phase A only first** (~9 days với custom auth). Beta 1-2 customer dùng shared Chrome trong Phase A. Phase B sau khi validated. | Reduce risk |
| 7 | Cloud host | **Same VPS as dev-fb.autonow.vn** (64GB RAM, dư sức) | Co-locate cloud + agent (single tenant Phase A) |

### Phase A revised timeline (with custom auth)

| # | Deliverable | Day |
|---|---|---|
| 1 | Schema migration 003 + RLS policies | 1d |
| 2 | Email/password auth: bcrypt + JWT + session cookies | 1d |
| 3 | Resend integration: signup verification, password reset emails | 1d |
| 4 | Signup + login + verify + password reset UI | 1d |
| 5 | Update all existing endpoints với tenant filter | 1d |
| 6 | Settings page (Gemini key override, license display, password change) | 0.5d |
| 7 | UI sidebar header + onboarding wizard | 1d |
| 8 | Migrate anh's data → tenant 'tuantran' | 0.5d |
| 9 | Deploy fb.autonow.vn (cloudflared tunnel) | 0.5d |
| 10 | Smoke test với 2 test tenant users | 0.5d |
| | **Total Phase A** | **~9 ngày** |

### Auth tech stack

| Concern | Decision |
|---|---|
| Password hash | `bcrypt` (cost factor 12) |
| Session | JWT in httpOnly cookie (12h TTL) + sliding refresh |
| Email sending | `resend` SDK |
| Email templates | Inline HTML in TS (3 templates: verify, reset, welcome) — no MJML/templating engine for MVP |
| Verification flow | Signup → email với one-time token (24h TTL) → click link `/verify?token=X` |
| Password reset | Email với one-time token (1h TTL) → form `/reset?token=X` |
| Rate limit | `@fastify/rate-limit` on `/auth/*` endpoints (5 req/min/IP) |
| CSRF | SameSite=Lax cookies (sufficient for Fastify single-origin) |

## 14. Concrete next steps after approval

Em sẽ làm theo thứ tự sau khi anh approve plan + answer open questions:

1. **Day 1**: Write `sql/003_multitenant.sql` + apply locally; setup Clerk account + dev env
2. **Day 2**: Clerk middleware + signup/login UI + tenant provisioning
3. **Day 3-4**: Update existing endpoints với tenant filter + RLS policies
4. **Day 5**: Settings page + onboarding wizard + sidebar update
5. **Day 6**: Migrate anh's data → tenant 'tuantran'; smoke test
6. **Day 7**: Deploy fb.autonow.vn; manual create 2 test tenants; verify isolation

End of Phase A: anh có **fb.autonow.vn** chạy multi-tenant, anh là tenant đầu tiên, có thể tạo tenant thứ 2 để test isolation. Chrome vẫn share trên cùng VPS (sẽ tách trong Phase B).

→ Sau Phase A có thể mời 1-2 beta customer dùng thử (họ cũng dùng Chrome cloud-side, chưa cần tự cài VPS). Validate UI + onboarding flow. Khi hài lòng, tiến Phase B để mỗi customer tự VPS.
