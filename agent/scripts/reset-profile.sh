#!/usr/bin/env bash
# Reset chrome-profile — clears all cookies, localStorage, IndexedDB, cache.
# Use when FB is stuck in captcha loop or "session expired" loop, OR when
# customer wants to switch to a different FB account.
#
# Stops login service first (if running) so the profile isn't locked.
# Customer should run `systemctl start auto-facebook-agent-login` after.

set -euo pipefail

PROFILE="${AGENT_CHROME_PROFILE:-/var/lib/auto-facebook-agent/chrome-profile}"
LOCK_FILE="/var/lib/auto-facebook-agent/login.lock"
AGENT_USER="auto-fb-agent"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: must be run as root (sudo)."
  exit 1
fi

echo "==> Stopping login service (if running)"
systemctl stop auto-facebook-agent-login 2>/dev/null || true
sleep 2

echo "==> Cleaning chrome profile at $PROFILE"
if [ -d "$PROFILE" ]; then
  # Remove the entire profile so Chrome creates a fresh one on next launch.
  rm -rf "${PROFILE:?}"/*  "${PROFILE:?}"/.[!.]* 2>/dev/null || true
fi
rm -f "$LOCK_FILE"

# Recreate skeleton + ownership
mkdir -p "$PROFILE"
chown -R "$AGENT_USER:$AGENT_USER" "$PROFILE"

echo "==> Profile reset done. Next steps:"
echo "    systemctl start auto-facebook-agent-login"
echo "    Open the noVNC URL in a browser → log in to FB again"
