#!/usr/bin/env bash
# Launches a headed Chrome on DISPLAY=:202 with the agent's persistent profile,
# pointed at facebook.com so customer can log in via noVNC.
#
# While this runs:
#   - /var/lib/auto-facebook-agent/login.lock exists → ETL agent skips crawls
#   - chrome-profile is exclusively held by this Chrome process
#
# Customer closes Chrome window (via noVNC) → Chrome exits → systemd unit
# becomes inactive → lock cleaned up → ETL resumes.

set -euo pipefail

CHROME_BIN="${CHROME_PATH:-/usr/bin/google-chrome}"
PROFILE="${AGENT_CHROME_PROFILE:-/var/lib/auto-facebook-agent/chrome-profile}"
LOCK_FILE="/var/lib/auto-facebook-agent/login.lock"
NAV_URL_FILE="/var/lib/auto-facebook-agent/login-nav-url"

# Read target URL from file (set by agent commands.ts based on user input).
# Defaults to FB home if file missing or invalid.
TARGET_URL="https://www.facebook.com/"
if [ -r "$NAV_URL_FILE" ]; then
  CANDIDATE="$(cat "$NAV_URL_FILE" 2>/dev/null | tr -d '\n\r ' | head -c 500)"
  case "$CANDIDATE" in
    https://www.facebook.com/*|https://facebook.com/*|http://www.facebook.com/*|http://facebook.com/*)
      TARGET_URL="$CANDIDATE"
      ;;
  esac
fi
echo "[login] target URL: $TARGET_URL"

# DISPLAY should be set by EnvironmentFile (agent.env), default to :202
export DISPLAY="${DISPLAY:-:202}"

# Mark login mode active; cleaned up automatically on exit (normal or kill).
touch "$LOCK_FILE"
WM_PID=""
cleanup() {
  rm -f "$LOCK_FILE"
  [ -n "$WM_PID" ] && kill "$WM_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start a tiny window manager on this display so Chrome's window actually
# gets mapped (frame + focus + raise). Without a WM, the window stays in the
# default "withdrawn" state — Chrome renders into it but the X server never
# composites it onto the root window → noVNC viewer sees just the modal/cursor.
if command -v openbox >/dev/null 2>&1; then
  openbox --replace > /dev/null 2>&1 &
  WM_PID=$!
  sleep 0.5
  echo "[login] openbox started (pid $WM_PID) on DISPLAY=$DISPLAY"
fi

echo "[login] starting Chrome on DISPLAY=$DISPLAY with profile=$PROFILE"
echo "[login] open noVNC URL in browser to interact with this Chrome window"

# --app=URL: standalone "site app" mode → no tab bar, no URL bar, no
# bookmarks bar, no extension UI. User can ONLY interact with the FB page,
# can't open new tabs (Ctrl+T disabled in app mode), can't navigate to other
# sites, can't access Chrome settings.
# --kiosk: fullscreen + no window controls (no minimize/maximize/close button).
# Combined → user sees ONLY facebook.com, fully locked-down kiosk.
exec "$CHROME_BIN" \
  --user-data-dir="$PROFILE" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --no-first-run \
  --no-default-browser-check \
  --disable-default-apps \
  --disable-extensions \
  --disable-features=TranslateUI,Translate \
  --disable-popup-blocking=false \
  --kiosk \
  --window-position=0,0 \
  --window-size=1920,1080 \
  --lang=vi-VN \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  --app="$TARGET_URL"
