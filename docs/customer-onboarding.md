# Onboarding cho khách hàng mới

Hệ thống fb.autonow.vn = một cloud trung tâm + một agent chạy trên VPS riêng của bạn để crawl Facebook. Setup mất ~30 phút.

## Điều kiện tiên quyết

- **VPS Ubuntu/Debian** (24.04 LTS khuyến nghị) với:
  - ≥ 2.5 GB RAM (hoặc ≥ 1 GB RAM + ≥ 4 GB swap)
  - ≥ 20 GB disk
  - **Quyền root** (truy cập `sudo` đầy đủ)
  - Public IPv4
  - Mở outbound HTTPS port 443 (tới `fb.autonow.vn`)
- **Tài khoản Facebook phụ** đã dùng ≥ 3 tháng (account < 3 tháng dễ bị FB challenge)
- **Tài khoản Telegram** + sẵn sàng tạo 1 bot riêng qua [@BotFather](https://t.me/BotFather)
- **(Tuỳ chọn) Google AI Studio key** để dùng quota Gemini riêng (free 1500 req/ngày)

---

## Bước 1 — Đăng ký tài khoản

1. Truy cập **https://fb.autonow.vn/auth/signup**
2. Điền email + mật khẩu mạnh + tên hiển thị
3. Kiểm tra inbox → bấm link verify (kiểm tra spam folder nếu không thấy)
4. Sau khi verify, **chờ admin duyệt** (thường trong 24h). Bạn sẽ nhận **email "Welcome"** chứa:
   - `LICENSE_KEY` của riêng bạn
   - Lệnh install 1 dòng để chạy trên VPS

> Nếu sau 24h chưa nhận, liên hệ admin: `tuankudo199@gmail.com`

---

## Bước 2 — Cài agent lên VPS

SSH vào VPS của bạn với quyền root, dán lệnh từ email Welcome:

```bash
curl -fsSL https://fb.autonow.vn/install.sh | sudo LICENSE_KEY=lk_xxx... bash
```

Script tự cài: Node.js 20, Chrome, Xvfb (display ảo), x11vnc, websockify, systemd service. Mất ~5-10 phút tuỳ tốc độ mạng VPS.

Sau khi cài xong:
- 4 service đã chạy: `auto-facebook-agent`, `-xvfb`, `-x11vnc`, `-websockify`
- VNC public URL hiện trong `/etc/auto-facebook-agent/agent.env` (xem dòng `VNC_PASSWORD=`)
- Lên https://fb.autonow.vn → đăng nhập → trạng thái agent hiển thị **🟢 online**

---

## Bước 3 — Login Facebook qua noVNC

Agent cần một session FB đăng nhập sẵn để crawl.

1. Trên dashboard → **Setup → Kết nối** → bấm **"🌐 Mở Facebook"**
2. Một browser Chrome sẽ khởi động trên VPS, hiển thị qua noVNC. Link noVNC hiện ngay trên dashboard:
   ```
   http://<VPS_IP>:6092/vnc.html?password=...
   ```
   (Password 128-bit lấy trong `/etc/auto-facebook-agent/agent.env`)
3. Mở link noVNC trong tab mới → login Facebook **trong cửa sổ noVNC** (bằng account phụ đã chuẩn bị)
4. Login xong → bấm **"Đóng Facebook"** trên dashboard
5. Trạng thái session chuyển **✅ fb_session_alive: true**

> Lưu ý: dùng account phụ đã có lịch sử dài. Account mới tinh dễ bị FB challenge → đứng pipeline.

---

## Bước 4 — Cấu hình Telegram bot

Để nhận thông báo lead tức thời.

1. Trong Telegram, search `@BotFather` → gửi `/newbot` → đặt tên + username → copy `bot token` (dạng `123456:ABC...`)
2. Tạo 1 group Telegram (private) → thêm bot vừa tạo vào group → gửi 1 tin nhắn bất kỳ trong group
3. Trên dashboard → **Setup → Cấu hình**:
   - Paste **bot token** → bấm **"🔍 Detect chat"** → hệ thống tự lấy `chat_id` từ Telegram API
   - (Tuỳ chọn) Nếu group là forum/supergroup có topic → bấm **"🔍 Detect topics"** → chọn topic HR / Fulfill nếu muốn route lead theo loại
4. Bấm **"📤 Send test"** → đảm bảo bot gửi được tin tới group
5. **Save**

---

## Bước 5 — Cấu hình rule lead + Gemini key (tuỳ chọn)

Vẫn ở **Setup → Cấu hình**:

1. **AI classifier**: tick "Bật Gemini phân loại lead"
2. **Gemini API key (của bạn)**: dán key từ [Google AI Studio](https://aistudio.google.com/app/apikey) (để trống = dùng key hệ thống, có giới hạn chia chung)
3. **Tiêu chí lead của shop**: viết bằng tiếng Việt mô tả shop bạn + post nào tính là lead. Ví dụ:
   ```
   Tôi bán dịch vụ in áo POD. Lead bao gồm:
   - Khách hỏi giá in áo, hỏi xưởng in áo
   - Khách tìm nhà cung cấp POD cho dropshipping
   Bỏ qua:
   - Bài tuyển dụng designer
   - Bài seeding kêu like share
   ```
4. **Min confidence**: 60-80% là vừa (thấp hơn → nhiều noise, cao hơn → bỏ sót)
5. **Chỉ lead trong**: 1 ngày (chỉ classify post mới đăng trong 24h gần đây)
6. **Chống trùng (dedup)**: 7 ngày (nhà tuyển dụng đăng lại bài giống hệt → chỉ tính 1 lead)
7. **Save rules + classifier**

---

## Bước 6 — Enable group muốn crawl

1. **Setup → Kết nối** → bấm **"🔄 Refresh groups list"** (sẽ mất ~30-60 giây — agent quét list group bạn đã join trên FB)
2. Sau khi xong → tab **Groups** sẽ liệt kê toàn bộ group bạn join
3. Tick **enable** cho các group muốn crawl (chỉ nên enable 5-15 group đầu tiên, sau quen có thể tăng)
4. Đợi đến chu kỳ crawl tiếp theo (max 15 phút)

---

## Bước 7 — Nhận lead đầu tiên

Sau khi enable group + có post mới trong group đó match rule lead của bạn:
- Pipeline crawl mỗi 15 phút → lead phát hiện → bắn Telegram tức thời
- Lead xuất hiện trong tab **Stream** trên dashboard

Lead message Telegram dạng:
```
🔥 Lead mới — Hỏi giá in áo POD  (92%)
👤 Nguyen Van A (https://facebook.com/...)
📍 Group: POD Việt Nam
💬 "Mình cần in 100 áo thun cotton, ib mình giá tốt nhé..."
[📩 IB] [💬 Comment] [📊 Cập nhật stage]
```

---

## Theo dõi & vận hành

- **Trạng thái agent**: dashboard → góc phải hiển thị 🟢/🟡/🔴 + heartbeat gần nhất
- **Disk usage**: heartbeat report % disk dùng — nếu > 85% sẽ có cảnh báo
- **ETL runs**: tab **Setup → Hoạt động (ETL)** xem chi tiết từng lần crawl
- **Gemini cost**: tab **Setup → Cấu hình** → panel "💰 Chi phí Gemini AI" — số token + chi phí theo ngày

**Nếu agent OFFLINE > 15 phút → bạn sẽ nhận Telegram alert tự động.**

---

## Troubleshooting

### Agent OFFLINE
- Check VPS panel xem VM còn chạy không
- SSH vào VPS chạy: `systemctl status auto-facebook-agent`
- Nếu service dead → `systemctl restart auto-facebook-agent` + xem log: `journalctl -u auto-facebook-agent -n 50`

### FB session hết hạn
- Heartbeat báo `fb_session_alive: false`
- Lặp lại Bước 3 (login qua noVNC). FB cookie thường sống vài tháng.

### License key bị "hostname_locked"
- Nghĩa là key đã đăng ký với VPS khác trước đó (hoặc bạn đổi hostname VPS)
- **Tự sửa**: dashboard → **Setup → Kết nối** → bấm **"🔓 Reset VPS lock"** (chỉ enable được khi agent đã offline ≥5 phút)
- Hoặc liên hệ admin nếu nút không khả dụng

### VPS chiếm dung lượng
- Disk thường ngốn: `/var/lib/auto-facebook-agent/chrome-profile/` (~1-2GB cache)
- Xoá an toàn (sẽ cần re-login FB): `systemctl stop auto-facebook-agent && rm -rf /var/lib/auto-facebook-agent/chrome-profile && systemctl start auto-facebook-agent`

### Sau khi admin VPS restore từ backup
- Hardening (Cockpit off, fail2ban, GRUB fix) có thể bị revert
- SSH vào VPS chạy: `bash /opt/auto-facebook-agent/scripts/harden-vps.sh`
- Mất ~30 giây, idempotent

---

## Liên hệ hỗ trợ

- Email: `tuankudo199@gmail.com`
- Mỗi yêu cầu support: kèm `LICENSE_KEY` + mô tả vấn đề + screenshot nếu có
