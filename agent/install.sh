#!/usr/bin/env bash
# fb.autonow.vn agent installer (v0.2 — B2 + B3-lite).
#
# Usage:  curl -fsSL __CLOUD_BASE_URL__/install.sh | LICENSE_KEY=lk_xxx bash
#
# Installs:
#   /opt/auto-facebook-agent/                — agent code (TypeScript via tsx)
#   /etc/auto-facebook-agent/                — config (license_key, vnc_password, ...)
#   /var/lib/auto-facebook-agent/            — Chrome profile, watermarks, VNC pw, PIDs
#   /var/log/auto-facebook-agent/            — Xvfb/x11vnc/websockify logs
#   /etc/systemd/system/auto-facebook-agent.service
#   /etc/systemd/system/auto-facebook-agent-stack.service
#   user `auto-fb-agent` (system user, nologin)
#
# Requires: Ubuntu 22.04+ / Debian (apt). Installs Node 20 + Chrome + noVNC stack
# if missing.

set -euo pipefail

CLOUD_BASE_URL="${CLOUD_BASE_URL:-__CLOUD_BASE_URL__}"
INSTALL_DIR="/opt/auto-facebook-agent"
CONFIG_DIR="/etc/auto-facebook-agent"
CONFIG_FILE="$CONFIG_DIR/config.json"
STACK_ENV_FILE="$CONFIG_DIR/stack.env"
SYSTEMD_AGENT="/etc/systemd/system/auto-facebook-agent.service"
SYSTEMD_STACK="/etc/systemd/system/auto-facebook-agent-stack.service"
SYSTEMD_LOGIN="/etc/systemd/system/auto-facebook-agent-login.service"
STATE_DIR="/var/lib/auto-facebook-agent"
LOG_DIR="/var/log/auto-facebook-agent"
AGENT_USER="auto-fb-agent"

XVFB_DISPLAY=":202"
VNC_RFB_PORT=5912
NOVNC_WEB_PORT=6092

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
banner()   { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

banner "fb.autonow.vn agent installer v0.3 (Lazy+Headless)"
echo "    cloud:        $CLOUD_BASE_URL"
echo "    install dir:  $INSTALL_DIR"
echo "    config:       $CONFIG_FILE"
echo

# ----- preflight -----
if [ "$EUID" -ne 0 ]; then
  c_red "ERROR: phải chạy bằng root (dùng sudo)."
  exit 1
fi
if [ -z "${LICENSE_KEY:-}" ]; then
  c_red "ERROR: thiếu env LICENSE_KEY."
  echo "Cách chạy đúng:"
  echo "  curl -fsSL $CLOUD_BASE_URL/install.sh | LICENSE_KEY=lk_xxx bash"
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  c_red "ERROR: hệ điều hành không hỗ trợ (cần Ubuntu/Debian)."
  exit 1
fi

# ----- RAM check -----
# v0.3 "Lazy+Headless": Chrome runs headless only during crawl tick (~5 min /
# 2h), then closes. Peak ~500MB. Idle ~150MB. With swap, even 3GB VPS works.
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
TOTAL_MB=$((RAM_MB + SWAP_MB))

if [ "$RAM_MB" -lt 2500 ] && [ "$TOTAL_MB" -lt 5000 ]; then
  c_red "ERROR: VPS chỉ có ${RAM_MB}MB RAM + ${SWAP_MB}MB swap."
  echo "Cần tối thiểu 2.5GB RAM HOẶC RAM+swap ≥ 5GB. Aborting."
  echo "Tip: tạo swap 4GB bằng:"
  echo "  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
  exit 1
elif [ "$RAM_MB" -lt 6000 ] && [ "$SWAP_MB" -lt 2000 ]; then
  c_yellow "⚠ VPS có ${RAM_MB}MB RAM + ${SWAP_MB}MB swap."
  echo "  Khuyến nghị: RAM ≥ 6GB HOẶC RAM + swap ≥ 6GB."
  echo "  Có thể chạy được với Lazy+Headless mode nhưng nên thêm swap."
  echo "  Đợi 5 giây trước khi tiếp tục (Ctrl+C để hủy)..."
  sleep 5
else
  c_green "✓ RAM: ${RAM_MB}MB + swap: ${SWAP_MB}MB"
fi

# ----- base deps -----
banner "Cài dependencies cơ bản (curl, jq, openssl)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar jq openssl >/dev/null

# ----- Node 20 -----
NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  CUR_MAJOR=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
  if [ "$CUR_MAJOR" -ge 20 ] 2>/dev/null; then
    NEED_NODE=false
    c_green "✓ Node.js $(node --version) đã cài sẵn"
  else
    c_yellow "⚠ Node.js $(node --version) quá cũ (cần ≥ v20). Sẽ cài v20."
  fi
fi
if [ "$NEED_NODE" = true ]; then
  banner "Cài Node.js 20 từ NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  c_green "✓ Node.js $(node --version) đã cài"
fi

# ----- Chrome / Chromium -----
banner "Cài Chrome (cho Playwright)"
CHROME_BIN=""
if command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN=$(command -v google-chrome)
  c_green "✓ google-chrome đã có: $CHROME_BIN"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN=$(command -v chromium)
  c_green "✓ chromium đã có: $CHROME_BIN"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN=$(command -v chromium-browser)
  c_green "✓ chromium-browser đã có: $CHROME_BIN"
else
  echo "Cài Google Chrome stable..."
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq google-chrome-stable; then
    CHROME_BIN=$(command -v google-chrome)
    c_green "✓ Google Chrome đã cài"
  else
    c_yellow "Google Chrome thất bại, fallback sang chromium..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium-browser || \
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium
    CHROME_BIN=$(command -v chromium-browser || command -v chromium)
  fi
fi
[ -n "$CHROME_BIN" ] || { c_red "ERROR: không cài được Chrome/Chromium"; exit 1; }

# ----- noVNC stack -----
banner "Cài noVNC stack (Xvfb + x11vnc + websockify + novnc)"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  xvfb x11vnc websockify novnc fonts-noto-color-emoji >/dev/null
c_green "✓ noVNC stack đã cài"

# ----- system user -----
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  banner "Tạo system user $AGENT_USER"
  useradd -r -s /usr/sbin/nologin -d "$INSTALL_DIR" -c "fb.autonow.vn agent" "$AGENT_USER"
fi

# ----- state + log dirs -----
mkdir -p "$STATE_DIR" "$STATE_DIR/run" "$STATE_DIR/chrome-profile" "$LOG_DIR"
chown -R "$AGENT_USER:$AGENT_USER" "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"

# ----- download + unpack agent -----
banner "Tải agent tarball"
TMPTGZ=$(mktemp /tmp/agent-XXXXX.tgz)
trap 'rm -f "$TMPTGZ"' EXIT
curl -fsSL --retry 3 "$CLOUD_BASE_URL/agent/latest.tgz" -o "$TMPTGZ"
SIZE=$(stat -c%s "$TMPTGZ")
if [ "$SIZE" -lt 1024 ]; then
  c_red "ERROR: tarball quá nhỏ ($SIZE bytes)"
  exit 1
fi
c_green "✓ Tải xong ($SIZE bytes)"

mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPTGZ" -C "$INSTALL_DIR"
chown -R "$AGENT_USER:$AGENT_USER" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/scripts/start-stack.sh" "$INSTALL_DIR/scripts/stop-stack.sh"

# ----- npm install (tsx + playwright + node-cron) -----
banner "Cài npm dependencies (tsx + playwright + node-cron)"
cd "$INSTALL_DIR"
# Skip downloading Playwright's bundled browsers — we use system Chrome.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  sudo -u "$AGENT_USER" -H \
  npm install --omit=dev --no-audit --no-fund --silent 2>&1 | tail -5
c_green "✓ npm dependencies cài xong"

# ----- VNC password -----
# 32 hex chars = 128 bits entropy — brute-force-infeasible even if attacker
# reaches port 6092 publicly. x11vnc accepts plain passwords; storepasswd hashes.
banner "Sinh VNC password"
VNC_PASS=$(openssl rand -hex 16)
x11vnc -storepasswd "$VNC_PASS" "$STATE_DIR/vnc.passwd" >/dev/null 2>&1
chown "$AGENT_USER:$AGENT_USER" "$STATE_DIR/vnc.passwd"
chmod 600 "$STATE_DIR/vnc.passwd"

# ----- config files -----
banner "Ghi config files"
mkdir -p "$CONFIG_DIR"
INSTALLED_AT=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

# Main agent config
cat > "$CONFIG_FILE" <<EOF
{
  "license_key": "$LICENSE_KEY",
  "cloud_url":   "$CLOUD_BASE_URL",
  "installed_at": "$INSTALLED_AT",
  "vnc_password": "$VNC_PASS",
  "vnc_port":    $NOVNC_WEB_PORT
}
EOF
chown "$AGENT_USER:$AGENT_USER" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

# Stack environment (Xvfb + Chrome path).
# VNC_BIND=0.0.0.0 → websockify accepts connections from any IP so the customer
# can browse to http://<their-vps-ip>:6092 directly. Customer's VPS firewall is
# the IP-level gate.
cat > "$STACK_ENV_FILE" <<EOF
XVFB_DISPLAY=$XVFB_DISPLAY
VNC_RFB_PORT=$VNC_RFB_PORT
NOVNC_WEB_PORT=$NOVNC_WEB_PORT
VNC_BIND=0.0.0.0
VNC_PASSWD_FILE=$STATE_DIR/vnc.passwd
NOVNC_DIR=/usr/share/novnc
PID_DIR=$STATE_DIR/run
LOG_DIR=$LOG_DIR
EOF
chmod 644 "$STACK_ENV_FILE"

# Agent environment (DISPLAY, CHROME_PATH, ...)
cat > "$CONFIG_DIR/agent.env" <<EOF
DISPLAY=$XVFB_DISPLAY
CHROME_PATH=$CHROME_BIN
BROWSER_HEADLESS=false
AGENT_CHROME_PROFILE=$STATE_DIR/chrome-profile
AGENT_STATE_PATH=$STATE_DIR/state.json
NODE_OPTIONS=--enable-source-maps
EOF
chmod 644 "$CONFIG_DIR/agent.env"

# ----- systemd units -----
# Stack is split into 3 separate services + 1 target (Xvfb, x11vnc, websockify
# each Type=simple with Restart=always). One dying → systemd respawns in 2s.
# The old monolithic stack.service is removed if present.
banner "Cài systemd units"
rm -f /etc/systemd/system/auto-facebook-agent-stack.service 2>/dev/null
install -m 644 "$INSTALL_DIR/systemd/auto-facebook-agent-xvfb.service"       /etc/systemd/system/
install -m 644 "$INSTALL_DIR/systemd/auto-facebook-agent-x11vnc.service"     /etc/systemd/system/
install -m 644 "$INSTALL_DIR/systemd/auto-facebook-agent-websockify.service" /etc/systemd/system/
install -m 644 "$INSTALL_DIR/systemd/auto-facebook-agent-stack.target"       /etc/systemd/system/
install -m 644 "$INSTALL_DIR/systemd/auto-facebook-agent.service"            "$SYSTEMD_AGENT"
install -m 644 "$INSTALL_DIR/systemd/auto-facebook-agent-login.service"      "$SYSTEMD_LOGIN"
chmod +x "$INSTALL_DIR/scripts/login.sh"
systemctl daemon-reload
systemctl enable --now auto-facebook-agent-stack.target
systemctl enable --now auto-facebook-agent-xvfb auto-facebook-agent-x11vnc auto-facebook-agent-websockify
systemctl enable --now auto-facebook-agent
# auto-facebook-agent-login is NOT enabled by default — customer triggers it
# from the cloud dashboard ("Open Facebook" button) which sends a command via
# heartbeat → agent runs `sudo systemctl start auto-facebook-agent-login`.

# ----- sudoers: let auto-fb-agent execute specific systemctl + scripts -----
# Required by src/commands.ts (dashboard-driven open/close login + discover_now)
banner "Cài sudoers rule cho dashboard commands"
cat > /etc/sudoers.d/auto-facebook-agent <<EOF
# Allow auto-fb-agent to run specific systemctl + helper without password.
# Drives the dashboard "Open Facebook" / "Discover groups" buttons.
auto-fb-agent ALL=(root) NOPASSWD: /bin/systemctl start auto-facebook-agent-login
auto-fb-agent ALL=(root) NOPASSWD: /bin/systemctl stop auto-facebook-agent-login
auto-fb-agent ALL=(root) NOPASSWD: /opt/auto-facebook-agent/scripts/discover-now.sh
EOF
chmod 440 /etc/sudoers.d/auto-facebook-agent
visudo -c -q -f /etc/sudoers.d/auto-facebook-agent && c_green "✓ sudoers OK" || c_red "⚠ sudoers syntax error"

# ----- verify -----
banner "Đợi heartbeat đầu tiên (15s)..."
sleep 15
if systemctl is-active --quiet auto-facebook-agent; then
  c_green "✓ auto-facebook-agent đang chạy"
else
  c_red "✗ auto-facebook-agent KHÔNG chạy"
  systemctl status auto-facebook-agent --no-pager || true
  exit 1
fi
if systemctl is-active --quiet auto-facebook-agent-stack; then
  c_green "✓ auto-facebook-agent-stack đang chạy"
else
  c_yellow "⚠ auto-facebook-agent-stack không active (chỉ ảnh hưởng tới noVNC, agent vẫn heartbeat)"
fi

echo
c_blue "Log agent (15 dòng gần nhất):"
journalctl -u auto-facebook-agent -n 15 --no-pager || true

# ----- success message -----
# Detect public IP best-effort: try ip metadata, fall back to ifconfig.me, then hostname.
PUBLIC_IP=$(curl -fs -m 3 https://api.ipify.org 2>/dev/null \
         || curl -fs -m 3 https://ifconfig.me 2>/dev/null \
         || hostname -I 2>/dev/null | awk '{print $1}' \
         || echo "<vps-public-ip>")
NOVNC_URL="http://${PUBLIC_IP}:${NOVNC_WEB_PORT}/vnc.html?autoconnect=true&resize=scale&password=${VNC_PASS}"

echo
c_green "════════════════════════════════════════════════════════════════"
c_green "  ✓ Agent đã cài thành công!"
c_green "════════════════════════════════════════════════════════════════"
echo
c_yellow "━━━ ĐỂ LOGIN FACEBOOK LẦN ĐẦU (chỉ 1 lần) ━━━"
echo
echo "  1. Khởi động Chrome (sẽ ngốn ~1.5GB RAM trong vài phút):"
echo
echo "     systemctl start auto-facebook-agent-login"
echo
echo "  2. Mở browser, vô link noVNC:"
echo
echo "     $NOVNC_URL"
echo
echo "  3. Cửa sổ Chrome hiện ra trong noVNC → đăng nhập Facebook bình thường."
echo
echo "  4. Xong → systemctl stop auto-facebook-agent-login"
echo "     (kiosk mode → không có X button; phải systemctl stop)"
echo "     ETL agent tự crawl mỗi 2h."
echo
echo "  5. Force-crawl ngay (test):"
echo "     systemctl restart auto-facebook-agent"
echo
echo "  ⚠ NẾU FB BÁO CAPTCHA LOOP / LOGIN THẤT BẠI:"
echo "     bash /opt/auto-facebook-agent/scripts/reset-profile.sh"
echo "     (xoá cookies/cache → login lại từ đầu)"
echo

# Run hardening (GRUB fix + mask Cockpit + UFW allow + fail2ban). Idempotent.
# Set SKIP_HARDEN=1 to skip (advanced users with custom security setup).
if [ "${SKIP_HARDEN:-0}" != "1" ] && [ -f "$INSTALL_DIR/scripts/harden-vps.sh" ]; then
  c_yellow "━━━ HARDENING VPS ━━━"
  bash "$INSTALL_DIR/scripts/harden-vps.sh" || c_yellow "⚠ harden-vps.sh có lỗi (không chặn agent), check log trên"
  echo
fi

c_yellow "━━━ THÔNG TIN AGENT ━━━"
echo
echo "  Dashboard data:   $CLOUD_BASE_URL/  (login bằng email đã đăng ký)"
echo "  noVNC URL:        $NOVNC_URL"
echo "  noVNC password:   $VNC_PASS"
echo "  Xem log agent:    journalctl -fu auto-facebook-agent"
echo "  Xem log stack:    journalctl -u auto-facebook-agent-stack -n 50"
echo "  Config:           $CONFIG_FILE"
echo
c_yellow "━━━ FIREWALL ━━━"
echo
echo "  Port $NOVNC_WEB_PORT phải mở inbound. Hetzner/Vultr/DO mặc định đã mở."
echo "  AWS/GCP/Azure: thêm port $NOVNC_WEB_PORT vào security group / firewall."
echo "  Check thử: từ máy khác chạy:  curl -m 3 http://${PUBLIC_IP}:${NOVNC_WEB_PORT}/"
echo
c_yellow "━━━ UNINSTALL ━━━"
echo
echo "  systemctl disable --now auto-facebook-agent auto-facebook-agent-stack auto-facebook-agent-login 2>/dev/null"
echo "  rm -rf $INSTALL_DIR $CONFIG_DIR $STATE_DIR $LOG_DIR"
echo "  rm -f $SYSTEMD_AGENT $SYSTEMD_STACK $SYSTEMD_LOGIN"
echo "  systemctl daemon-reload && userdel $AGENT_USER"
echo
