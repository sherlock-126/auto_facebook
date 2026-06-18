# Incident runbook — auto_facebook agent (caycuoc)

Ngắn gọn, copy-paste được. Cập nhật khi gặp ca mới.

**Hằng số cần nhớ:**
- VPS agent: `103.56.161.222` — SSH port `24700`, noVNC port `6092`
- Cloud server public IP (phải whitelist trên VPS): **`113.161.57.9`**
- Agent install path: `/opt/auto-facebook-agent/`
- Agent env: `/etc/auto-facebook-agent/agent.env`
- Systemd units: `auto-facebook-agent.service` + `-xvfb` + `-x11vnc` + `-websockify` + `-login`

---

## 🚨 Telegram báo "Agent OFFLINE"

1. **Check VPS panel** (CSPlatform): VM có còn chạy không?
2. Nếu VM down → Start lại từ panel. Đợi 1-2 phút.
3. Nếu VM up nhưng vẫn không heartbeat:
   - Có console panel? Vào console kiểm tra:
     - Nếu màn `grub rescue>` → xem ca dưới
     - Nếu màn login bình thường → đăng nhập, chạy `systemctl status auto-facebook-agent` để xem lỗi
   - Không có console? Thử SSH: `ssh -p 24700 root@103.56.161.222 'systemctl restart auto-facebook-agent && journalctl -u auto-facebook-agent -n 30 --no-pager'`
4. Khi heartbeat trở lại → nhận tin `✅ Agent ONLINE lại sau Xm` trên Telegram.

---

## 💀 VPS rớt vào `grub rescue>`

Xảy ra khi bootloader hỏng (đã thấy 1 lần 30/5). Recovery từ console VPS panel:

```
grub rescue> ls
(hd0) (hd0,gpt2) (hd0,gpt1)

grub rescue> ls (hd0,gpt2)/boot/grub/i386-pc/normal.mod
   ← nếu liệt kê được file thì gpt2 đúng; nếu "not found" thì thử gpt1

grub rescue> set prefix=(hd0,gpt2)/boot/grub
grub rescue> set root=(hd0,gpt2)
grub rescue> insmod normal
grub rescue> normal
   ← máy boot vào Ubuntu bình thường
```

**SAU KHI VÀO ĐƯỢC OS — BẮT BUỘC chạy ngay** (chống lặp lại):
```
sudo grub-install /dev/sda
sudo update-grub
```

Hoặc tốt hơn, chạy luôn script tổng:
```
bash /opt/auto-facebook-agent/scripts/harden-vps.sh
```
(Script này idempotent — chạy nhiều lần OK.)

---

## 🔄 Sau khi admin VPS restore từ backup

Backup thường là bản cũ → mất hết hardening đã làm (Cockpit chạy lại port 9090, fail2ban bị xoá, v.v.). Phải chạy lại:

```
ssh -p 24700 root@103.56.161.222
cd /opt/auto-facebook-agent
bash scripts/harden-vps.sh    # tốn ~30s
```

Kiểm tra sau khi chạy:
- `systemctl is-active cockpit.socket` → `inactive` (đã mask)
- `ufw status` → chỉ allow 24700/6092/80/443/18789/18791
- `fail2ban-client status` cho thấy `113.161.57.9` ở ignoreip
- `ls /boot/grub/i386-pc/normal.mod` → tồn tại

Nếu agent code cũng bị quay về bản cũ → re-deploy từ cloud:
```
# trên cloud server
tar -czf /tmp/agent-update.tgz -C /root/.vibedev/repos/auto_facebook/agent src scripts
scp -P 24700 /tmp/agent-update.tgz root@103.56.161.222:/tmp/
ssh -p 24700 root@103.56.161.222 'cd /opt/auto-facebook-agent && tar -xzf /tmp/agent-update.tgz && systemctl restart auto-facebook-agent'
```

---

## 🟡 Pipeline chậm / lead không về

1. Check ETL run gần đây trên cloud DB:
   ```sql
   SELECT kind, started_at::timestamp(0), extract(epoch from (finished_at-started_at))::int AS sec, status
     FROM etl_run WHERE started_at > NOW() - INTERVAL '2h' ORDER BY started_at DESC LIMIT 20;
   ```
2. Nếu agent in-flight quá lâu (>20 phút cho incr) → có thể bị kẹt → `systemctl restart auto-facebook-agent` trên VPS.
3. Check Gemini có 503 burst không (Google AI quá tải): `journalctl -u auto-facebook | grep "gemini call failed" | tail`.
4. Check FB session: heartbeat có `fb_session_alive=true` không. Nếu false → cần re-login qua noVNC (`https://103.56.161.222:6092/vnc.html?password=...`).

---

## ⚠ Telegram báo "Disk 87%"

(Sẽ enable sau khi heartbeat báo disk%.) Trên VPS:
```
df -h /
du -sh /var/log/* /opt/auto-facebook-agent/* /var/lib/auto-facebook-agent/* 2>/dev/null | sort -h | tail
```
Thông thường:
- `/var/lib/auto-facebook-agent/chrome-profile/` to lên (Chrome cache) — có thể xoá an toàn (mất session FB, cần login lại): `systemctl stop auto-facebook-agent && rm -rf /var/lib/auto-facebook-agent/chrome-profile && systemctl start auto-facebook-agent`
- `/var/log/journal/` ngốn nhiều — `journalctl --vacuum-time=7d`
- Docker images cũ — `docker system prune -af`
