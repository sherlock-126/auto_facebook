#!/usr/bin/env bash
# Repair the agent browser — installs a real .deb google-chrome-stable and points
# the agent at it. Fixes the most common install failure: a snap-packaged chromium
# that cannot launch from systemd ("not a snap cgroup" → login_active never true).
#
# Idempotent: if a non-snap Chrome already exists it just re-points CHROME_PATH.
# Triggered from the dashboard "Repair browser" button (via sudo). Restarts the
# agent at the end so the new CHROME_PATH takes effect.
#
# Usage: repair-browser.sh   (must run as root — invoked via sudo)

set -euo pipefail

CONFIG_DIR="/etc/auto-facebook-agent"
AGENT_ENV="$CONFIG_DIR/agent.env"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: must be run as root (sudo)."
  exit 1
fi

is_snap() { case "$1" in /snap/*) return 0;; *) return 1;; esac; }

# 1. Look for an existing non-snap browser.
CHROME_BIN=""
for cand in google-chrome google-chrome-stable chromium chromium-browser; do
  p="$(command -v "$cand" 2>/dev/null || true)"
  [ -n "$p" ] || continue
  rp="$(readlink -f "$p" 2>/dev/null || echo "$p")"
  if ! is_snap "$p" && ! is_snap "$rp"; then
    CHROME_BIN="$p"; echo "==> Found non-snap browser: $CHROME_BIN"; break
  else
    echo "==> Ignoring snap browser $p (cannot run from systemd)."
  fi
done

# 2. Install google-chrome-stable if none usable.
if [ -z "$CHROME_BIN" ]; then
  echo "==> Installing google-chrome-stable (.deb)…"
  # Pipe through tee so re-running overwrites the keyring cleanly (gpg --dearmor -o
  # refuses to overwrite an existing file non-interactively).
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor | tee /usr/share/keyrings/google-chrome.gpg >/dev/null
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq google-chrome-stable
  CHROME_BIN="$(command -v google-chrome)"
fi

[ -n "$CHROME_BIN" ] || { echo "ERROR: could not find or install a non-snap Chrome."; exit 2; }
echo "==> Using CHROME_PATH=$CHROME_BIN"

# 3. Re-point CHROME_PATH in agent.env (replace existing line or append).
if [ -f "$AGENT_ENV" ] && grep -q '^CHROME_PATH=' "$AGENT_ENV"; then
  sed -i "s|^CHROME_PATH=.*|CHROME_PATH=$CHROME_BIN|" "$AGENT_ENV"
else
  echo "CHROME_PATH=$CHROME_BIN" >> "$AGENT_ENV"
fi

# 4. Restart so the agent (and any future login Chrome) uses the new binary.
#    Detach via systemd-run so the agent stopping itself can't abort the restart.
echo "==> Restarting agent…"
systemctl stop auto-facebook-agent-login 2>/dev/null || true
if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --collect /bin/systemctl restart auto-facebook-agent >/dev/null 2>&1 \
    || systemctl restart auto-facebook-agent
else
  systemctl restart auto-facebook-agent
fi

echo "OK browser repaired — CHROME_PATH=$CHROME_BIN. Click 'Open Facebook' to log in."
