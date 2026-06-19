#!/usr/bin/env bash
# Trigger an immediate "full" crawl — runs fb_joined_groups discover + crawl
# all enabled groups. Use after the customer joins new FB groups via noVNC so
# they show up in the dashboard within ~2 min instead of waiting until 3am.
#
# Stops the agent service first (chrome-profile lock), runs the one-shot crawl
# as auto-fb-agent, then restarts the agent (so cron resumes).

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: must be run as root (sudo)."
  exit 1
fi

LOCK_FILE="/var/lib/auto-facebook-agent/login.lock"
if [ -f "$LOCK_FILE" ] || systemctl is-active --quiet auto-facebook-agent-login; then
  echo "==> Stopping login service (chrome-profile lock)"
  systemctl stop auto-facebook-agent-login 2>/dev/null || true
  rm -f "$LOCK_FILE"
  sleep 2
fi

echo "==> Stopping ETL agent (chrome-profile lock)"
systemctl stop auto-facebook-agent
sleep 2

echo "==> Running discover-now (this may take 1-3 min — opens headless Chrome briefly)"
cd /opt/auto-facebook-agent
sudo -u auto-fb-agent HOME=/opt/auto-facebook-agent \
  AGENT_CHROME_PROFILE=/var/lib/auto-facebook-agent/chrome-profile \
  CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}" \
  DISPLAY=:202 \
  AGENT_STATE_PATH=/var/lib/auto-facebook-agent/state.json \
  /opt/auto-facebook-agent/node_modules/.bin/tsx \
  /opt/auto-facebook-agent/scripts/discover-now.ts

echo "==> Restarting ETL agent (cron resumes)"
systemctl start auto-facebook-agent

echo "OK Done. Open your dashboard at https://nextclaw.vn/ to see new groups."
