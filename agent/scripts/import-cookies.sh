#!/usr/bin/env bash
# Import FB cookies from a JSON file (exported from customer's own browser via
# "EditThisCookie" or "Cookie-Editor" extension) into the agent's Chrome profile.
#
# Why this exists: FB heavily fingerprints + IP-checks login attempts from
# datacenter IPs. Captcha loops are common. By importing already-valid cookies
# from a browser that FB already trusts, we skip the login flow entirely.
#
# Usage:
#   1. On your laptop: install "Cookie-Editor" extension in Chrome/Firefox.
#   2. Visit facebook.com, login as the account you want to crawl.
#   3. Open Cookie-Editor → click Export → "Export as JSON" → copy.
#   4. On the VPS: paste into /tmp/fb-cookies.json (or scp it there).
#   5. Run: sudo bash /opt/auto-facebook-agent/scripts/import-cookies.sh /tmp/fb-cookies.json
#   6. systemctl restart auto-facebook-agent  → first crawl uses the cookies.
#
# The script uses Playwright (via tsx) to write cookies into the persistent
# chrome-profile via storageState, then closes Chrome. Agent's next crawl
# launches headless Chrome with that profile.

set -euo pipefail

COOKIES_JSON="${1:?Usage: $0 <path-to-fb-cookies.json>}"
PROFILE="${AGENT_CHROME_PROFILE:-/var/lib/auto-facebook-agent/chrome-profile}"
AGENT_USER="auto-fb-agent"
LOCK_FILE="/var/lib/auto-facebook-agent/login.lock"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: phải chạy bằng root (sudo)."
  exit 1
fi

if [ ! -f "$COOKIES_JSON" ]; then
  echo "ERROR: file không tồn tại: $COOKIES_JSON"
  exit 1
fi

if [ -f "$LOCK_FILE" ] || systemctl is-active --quiet auto-facebook-agent-login; then
  echo "==> Stopping login service (profile lock)"
  systemctl stop auto-facebook-agent-login 2>/dev/null || true
  sleep 2
fi

if systemctl is-active --quiet auto-facebook-agent; then
  echo "==> Stopping agent service (profile lock)"
  systemctl stop auto-facebook-agent
  sleep 2
fi

mkdir -p "$PROFILE"
chown -R "$AGENT_USER:$AGENT_USER" "$PROFILE"

# Copy cookies to a place auto-fb-agent can read.
TMP_COOKIES="/var/lib/auto-facebook-agent/.tmp-cookies.json"
cp "$COOKIES_JSON" "$TMP_COOKIES"
chown "$AGENT_USER:$AGENT_USER" "$TMP_COOKIES"
chmod 600 "$TMP_COOKIES"

echo "==> Importing cookies into $PROFILE"
sudo -u "$AGENT_USER" \
  HOME=/opt/auto-facebook-agent \
  AGENT_CHROME_PROFILE="$PROFILE" \
  CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}" \
  /opt/auto-facebook-agent/node_modules/.bin/tsx \
  /opt/auto-facebook-agent/scripts/import-cookies.ts "$TMP_COOKIES"

rm -f "$TMP_COOKIES"

echo "==> Done. Now start the agent:"
echo "    systemctl start auto-facebook-agent"
echo "    journalctl -fu auto-facebook-agent"
