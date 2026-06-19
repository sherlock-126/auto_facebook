#!/usr/bin/env bash
# On-demand HTTPS tunnel for the noVNC viewer.
#
# Why: the noVNC stack listens on http://<vps-ip>:6092, which is unreachable when
# the VPS is behind NAT/firewall, and can't be embedded in the HTTPS dashboard
# (mixed-content). This wraps it in a Cloudflare quick-tunnel so the customer gets
# an https://<random>.trycloudflare.com URL that works from anywhere and embeds in
# an <iframe> on nextclaw.vn — no IP, no port-forward, no terminal.
#
# Lifecycle: started by the agent on `open_login`, stopped on `close_login`.
# The tunnel runs as a transient systemd unit (survives this script exiting),
# and the resolved URL is written to vnc-tunnel-url for the heartbeat to report.
#
# Usage: vnc-tunnel.sh start|stop   (must run as root — invoked via sudo)

set -euo pipefail

ACTION="${1:-start}"
UNIT="nextclaw-vnc-tunnel"
STATE_DIR="/var/lib/auto-facebook-agent"
URL_FILE="$STATE_DIR/vnc-tunnel-url"
LOG_FILE="$STATE_DIR/cloudflared.log"
AGENT_USER="auto-fb-agent"

# Resolve the noVNC web port from the stack env (falls back to the install default).
NOVNC_WEB_PORT=6092
[ -r /etc/auto-facebook-agent/stack.env ] && . /etc/auto-facebook-agent/stack.env || true
PORT="${NOVNC_WEB_PORT:-6092}"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: must be run as root (sudo)."
  exit 1
fi

stop_tunnel() {
  systemctl stop "$UNIT" 2>/dev/null || true
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  rm -f "$URL_FILE"
}

if [ "$ACTION" = "stop" ]; then
  stop_tunnel
  echo "OK tunnel stopped"
  exit 0
fi

# ----- start -----
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared not installed (re-run install.sh to add it)."
  exit 2
fi

stop_tunnel          # clear any stale unit/url first
: > "$LOG_FILE"
chown "$AGENT_USER:$AGENT_USER" "$LOG_FILE" 2>/dev/null || true

# Transient unit so the tunnel outlives this script. --collect cleans it up on stop.
# Keep --logfile AND let systemd capture stdout/stderr to the journal — cloudflared
# may print the quick-tunnel URL to either, so we scan both below.
systemd-run --unit="$UNIT" --collect \
  cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}" --logfile "$LOG_FILE" \
  >/dev/null 2>&1

# cloudflared prints the assigned https://<random>.trycloudflare.com URL within a
# few seconds — scan the logfile and the unit's journal. Poll up to ~25s.
URL=""
for _ in $(seq 1 50); do
  URL="$( { cat "$LOG_FILE" 2>/dev/null; journalctl -u "$UNIT" --no-pager -o cat 2>/dev/null; } \
          | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "ERROR: tunnel URL did not appear within 25s (cloudflared may be rate-limited)."
  stop_tunnel
  exit 3
fi

echo "$URL" > "$URL_FILE"
chown "$AGENT_USER:$AGENT_USER" "$URL_FILE" 2>/dev/null || true
echo "OK tunnel up: $URL"
