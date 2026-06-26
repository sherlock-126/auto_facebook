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

stop_tunnel          # stop any old tunnel + REMOVE the stale url file first, so the
                     # heartbeat never publishes a dead URL while the new one comes up.
# Belt-and-braces: kill any orphan quick-tunnel not owned by our unit.
pkill -f 'cloudflared tunnel --url http://localhost' 2>/dev/null || true
: > "$LOG_FILE"      # truncate — must read the URL of THIS run only (see below)
chown "$AGENT_USER:$AGENT_USER" "$LOG_FILE" 2>/dev/null || true

# Transient unit so the tunnel outlives this script. --collect cleans it up on stop.
systemd-run --unit="$UNIT" --collect \
  cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}" --logfile "$LOG_FILE" \
  >/dev/null 2>&1

# Read the assigned https://<random>.trycloudflare.com URL ONLY from the freshly
# truncated logfile. (Do NOT scan `journalctl -u $UNIT` — the unit name is reused,
# so its journal accumulates URLs from PAST runs and we would pick up a dead one.)
# Use tail -1 to take the most recent line. Poll up to ~25s.
URL=""
for _ in $(seq 1 50); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "ERROR: tunnel URL did not appear within 25s (cloudflared may be rate-limited)."
  stop_tunnel
  exit 3
fi

# Wait until the tunnel is actually reachable before publishing it — a freshly
# created quick-tunnel returns Cloudflare 530/1033 for a few seconds. Best-effort:
# publish after up to ~30s even if the probe never flips to 200.
code="000"
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "${URL}/vnc.html" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 1
done

echo "$URL" > "$URL_FILE"
chown "$AGENT_USER:$AGENT_USER" "$URL_FILE" 2>/dev/null || true
echo "OK tunnel up: $URL (reachability http=$code)"
