# auto_facebook

Scrape posts/comments từ **Facebook groups bạn đã join** → Postgres warehouse.
Setup giống hệt `adg_database` (MISA AMIS scraper): native Postgres + Xvfb/x11vnc/noVNC + Cloudflare Tunnel + Fastify dashboard. Khác chỉ ở **ports** (để chạy song song trên cùng VPS) và **scraping target**.

> ⚠️ Vi phạm ToS của Facebook. Account phụ ≥3 tháng. Đừng public sản phẩm.

## Quickstart (VPS Ubuntu, đã có MISA chạy sẵn)

```bash
git clone <repo> auto_facebook && cd auto_facebook
npm install
npm run db:init          # generates .env (gens PG + VNC password), creates fb_etl/fb_warehouse, migrates
npm run stack:up         # Xvfb :201 + x11vnc 5911 + websockify 6091
npm start &              # Fastify :4200
npm run scheduler &      # node-cron worker
```

Thêm 2 hostname vào `/etc/cloudflared/config.yml`:
```yaml
- hostname: fb.yourdomain.com         { service: http://localhost:4200 }
- hostname: fb-vnc.yourdomain.com     { service: http://localhost:6091 }
```

Mở `https://fb.yourdomain.com` → walkthrough qua dashboard (Login → Discover → Wire entity → Run).

Chi tiết từng bước: [`docs/ONBOARDING_CHECKLIST.md`](docs/ONBOARDING_CHECKLIST.md).

## Port allocation (tránh đụng MISA)

| Service       | MISA   | auto_facebook |
|---------------|--------|---------------|
| App           | 4100   | **4200**      |
| Postgres      | 5433   | **5434**      |
| Xvfb display  | :200   | **:201**      |
| VNC RFB       | 5910   | **5911**      |
| noVNC web     | 6090   | **6091**      |

Đổi trong `.env` nếu cần.

## Workflow

```
1. Login (1 lần)           → noVNC manual login → save storage_state
2. Discover (1 lần/entity) → noVNC browse group, scroll → table friendly_name+count
3. Wire entity             → paste doc_id + friendly_name vào src/etl/entities/*.ts
4. Run                     → scheduler tự chạy mỗi 30 phút
```

## Cấu trúc

```
src/
  db.ts                            # PG pool (PG_HOST/PORT/USER/PASSWORD/DATABASE)
  cli.ts                           # ETL CLI: tsx src/cli.ts run <entity> <scope> [incr|full]
  scheduler.ts                     # node-cron + PG advisory lock
  server.ts                        # Fastify :4200 (APP_PORT) + dashboard + login/discover UI
  fb/
    session.ts                     # Save/load storage_state per c_user (§4)
    auth.ts                        # Extract fb_dtsg, lsd, jazoest, spin_* (§5)
    graphql.ts                     # XHR replay (§6 fetch-hook bypass)
    discover.ts                    # XHR capture mode → xhr_capture
    budget.ts                      # 400 req/day + 25-55s random delay
    client.ts                      # Browser + auth + graphql replay
  etl/
    upsert.ts                      # Chunked + dedup (§11)
    watermark.ts                   # Per-entity, per-scope CDC (§8)
    entity_registry.ts             # EntityConfig + registered entities
    entities/
      fb_joined_groups.ts          # SKELETON — wire after discover
      fb_group_post.ts             # SKELETON — wire after discover
    runner.ts                      # runAll / runOne
sql/
  001_init.sql                     # dim_group, fact_group_post, fb_session, xhr_capture, ...
scripts/
  init-db.sh                       # Idempotent PG bootstrap (mirrors MISA)
  start-browser-stack.sh           # Xvfb + x11vnc + websockify
  stop-browser-stack.sh
docs/
  ONBOARDING_CHECKLIST.md          # Step-by-step VPS setup
data/                              # Runtime: data/run/*.pid, data/log/*.log, data/secrets/vnc.passwd
```

## CLI

```bash
npm start                                        # Fastify server
npm run scheduler                                # node-cron worker
npm run etl -- facts:all:incr                    # all enabled groups, incremental
npm run etl -- facts:all:full                    # rescan history
npm run etl -- run fb_group_post <gid> incr      # ad-hoc one entity
npm run stack:up / stack:down                    # browser stack
npm run db:init                                  # bootstrap PG + migrations
npm run typecheck                                # tsc --noEmit
```

## Khi nào re-login / re-discover

- `fb_dtsg` rotate vài giờ — client tự refresh khi gặp error 1357004.
- Session cookies (xs, c_user) bền hơn nhưng vẫn có thể bị FB revoke → `createFbClient()` throw `SessionWallError` → re-login qua noVNC.
- `friendly_name`/`doc_id` xoay tour vài tháng → khi entity bắt đầu trả 0 rows hoặc lỗi GraphQL → rerun discover mode tìm tên mới.

## Reference

[`adg_database/docs/SCRAPING_ARCHITECTURE.md`](../adg_database/docs/SCRAPING_ARCHITECTURE.md) là pattern gốc — đặc biệt §3 (Xvfb+noVNC), §4 (session), §5 (auth capture), §6 (XHR bypass), §8 (watermark), §11 (PG gotchas), §12 (anti-detection).
