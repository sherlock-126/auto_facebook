# auto_facebook — Onboarding checklist

Mục tiêu: chạy được trên VPS Ubuntu mới + expose qua Cloudflare Tunnel để demo, theo đúng pattern `adg_database` (MISA).

## Port allocation (khác MISA để chạy song song trên cùng VPS)

| Service       | MISA   | auto_facebook |
|---------------|--------|---------------|
| App (Fastify) | 4100   | **4200**      |
| Postgres      | 5433   | **5434**      |
| Xvfb display  | :200   | **:201**      |
| VNC RFB       | 5910   | **5911**      |
| noVNC web     | 6090   | **6091**      |

## 1. Cài deps hệ thống (1 lần per VPS)

Nếu VPS đã chạy MISA → đã có sẵn `xvfb`, `x11vnc`, `novnc`, `google-chrome`, `postgresql`. Skip phần này.

```bash
sudo apt update
sudo apt install -y xvfb x11vnc novnc websockify postgresql nodejs npm openssl
# Google Chrome (cần real Chrome, không phải bundled chromium)
wget -qO- https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

## 2. Postgres listening on port 5434 (nếu chưa có)

Edit `/etc/postgresql/<version>/main/postgresql.conf` → thêm dòng:
```
port = 5433
```
Wait — MISA dùng 5433. Nếu Postgres của bạn đang listen 5433 cho MISA và bạn muốn FB chia sẻ cùng instance, đặt `PG_PORT=5433` trong `.env` (giữ separate DB name `fb_warehouse` thì vẫn isolate dữ liệu). Nếu muốn instance riêng cho FB, tạo cluster mới:

```bash
sudo pg_createcluster 15 fb --port=5434
sudo pg_ctlcluster 15 fb start
```

Mặc định `.env.example` set `PG_PORT=5434` (instance riêng). Đổi xuống `5433` nếu share cluster với MISA.

## 3. Clone + bootstrap

```bash
cd ~
git clone <your-repo-url> auto_facebook
cd auto_facebook
npm install
npx playwright install --with-deps chromium  # optional; we prefer real Chrome via CHROME_PATH

npm run db:init   # creates .env (gens random PG + VNC passwords), creates role + DB + runs sql/001_init.sql
```

Sau bước này, `.env` đã tồn tại với mật khẩu thật. Mở ra check `APP_PUBLIC_URL` và `NOVNC_PUBLIC_URL` — đổi sang hostname Cloudflare bạn muốn dùng (vd `fb.autonow.vn`, `fb-vnc.autonow.vn`).

## 4. Khởi động browser stack + app

```bash
npm run stack:up   # Xvfb :201 + x11vnc 5911 + websockify 6091
npm start &        # Fastify :4200
npm run scheduler &  # node-cron worker (optional cho lần đầu test)
```

Script `stack:up` in ra noVNC URL + VNC password ở dòng cuối — copy lại.

## 5. Cloudflare Tunnel

Nếu VPS đã có `cloudflared` cho MISA → chỉ cần thêm 2 hostname mới vào file config hiện tại:

```yaml
# /etc/cloudflared/config.yml
ingress:
  - hostname: dev-adg.autonow.vn          # existing MISA
    service: http://localhost:4100
  - hostname: dev-adg-vnc.autonow.vn      # existing MISA
    service: http://localhost:6090
  - hostname: fb.autonow.vn               # NEW: FB dashboard
    service: http://localhost:4200
  - hostname: fb-vnc.autonow.vn           # NEW: FB noVNC
    service: http://localhost:6091
  - service: http_status:404
```

Tạo 2 DNS record CNAME tới tunnel:
```bash
cloudflared tunnel route dns <tunnel-name> fb.autonow.vn
cloudflared tunnel route dns <tunnel-name> fb-vnc.autonow.vn
sudo systemctl restart cloudflared
```

## 6. First login

1. Mở `https://fb.autonow.vn` → click **"Open Chrome (Xvfb)"**.
2. Mở tab khác: `https://fb-vnc.autonow.vn/vnc.html?autoconnect=true&resize=scale&password=<VNC_PASSWORD từ .env>`.
3. Login Facebook trong noVNC (account phụ ≥3 tháng, KHÔNG account chính).
4. Quay lại tab dashboard → **"Save session"**. Header "Session" sẽ hiện `c_user`.

## 7. Discover XHR endpoints

1. Dashboard → **"Start discover"**.
2. Trong noVNC: browser đã restore session, đang ở `facebook.com/groups/feed/`. Click vào 1 group bạn đã join → scroll feed 5-10 lần → click 1 post → expand comments.
3. Dashboard → **"Refresh captures"** → table sẽ hiện list `friendly_name` FB đã fire.
4. Click **view** trên hàng có tên kiểu `GroupsCometFeedRegularStoriesPaginationQuery` → đọc `request_body` (lấy `doc_id`) + `response_body` (xác định JSON path tới posts + `end_cursor`).
5. Dashboard → **"Stop discover"**.

## 8. Wire entity & test

Edit `src/etl/entities/fb_group_post.ts`:
- Thay `DOC_ID = null` bằng `doc_id` thật
- Thay `FRIENDLY_NAME = 'TODO_...'` bằng tên thật
- Implement `walkPosts()` parse response payload

Test:
```bash
npm run etl -- run fb_joined_groups global incr
# Enable 1 group qua dashboard (button "enable")
npm run etl -- run fb_group_post <group_id> incr
```

Nếu OK, scheduler đã chạy `*/30 * * * *` sẽ tự sync.

## 9. Smoke test checklist (trước khi gọi là "ready to demo")

- [ ] `npm start` không crash trong 5 phút (xem log)
- [ ] `curl http://localhost:4200/api/dashboard/stats` → trả JSON 200
- [ ] `https://fb.autonow.vn` mở được dashboard
- [ ] `https://fb-vnc.autonow.vn` load noVNC client
- [ ] Login flow lưu session vào `fb_session` (psql verify: `SELECT id, c_user, is_active FROM fb_session;`)
- [ ] Discover mode log XHR vào `xhr_capture` (`SELECT count(*), friendly_name FROM xhr_capture WHERE note='discover' GROUP BY friendly_name;`)
- [ ] 1 entity chạy đầu cuối: `SELECT count(*) FROM fact_group_post;` > 0
- [ ] `etl_run` có 1 row status=ok

## 10. Process supervisor (sau khi demo OK)

MISA hiện chạy bằng `npm start &` thuần (không systemd). Mặc định bạn cũng làm vậy cho MVP. Khi muốn ổn định hơn:

```ini
# /etc/systemd/system/auto-facebook.service
[Unit]
Description=auto_facebook Fastify server
After=network.target postgresql.service

[Service]
WorkingDirectory=/home/<user>/auto_facebook
ExecStart=/usr/bin/npm start
Restart=on-failure
User=<user>
EnvironmentFile=/home/<user>/auto_facebook/.env

[Install]
WantedBy=multi-user.target
```

Cùng pattern cho `auto-facebook-scheduler.service` (ExecStart=`/usr/bin/npm run scheduler`).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now auto-facebook auto-facebook-scheduler
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `db:init` fail "role postgres does not exist" | PG cluster name khác | `sudo -u <pg-superuser> psql ...` thay vì `postgres` |
| `stack:up` báo "/tmp/.X201-lock exists" | Old Xvfb chết để lại lock | `rm /tmp/.X201-lock /tmp/.X11-unix/X201` rồi rerun |
| noVNC kết nối được nhưng màn đen | Chrome chưa launch | Click "Open Chrome (Xvfb)" trên dashboard trước |
| Login OK nhưng `Save session` báo "no c_user cookie" | FB chưa redirect xong | Refresh page trong noVNC, đảm bảo URL là `facebook.com/` (không phải `/login`) |
| Discover không log XHR | Browser dùng cached session khác | Stop discover, restart, check `getDiscoverHandle()` trả non-null |
| Entity throw "1357004 Invalid form data" | `fb_dtsg` expired | Client tự retry sau khi `refreshAuth()` — nếu vẫn fail, mở noVNC re-login |
