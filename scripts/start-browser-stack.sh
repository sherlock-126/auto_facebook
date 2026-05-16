#!/usr/bin/env bash
# Starts dedicated Xvfb + x11vnc + websockify (noVNC) stack for auto_facebook.
# Uses display :201 / rfb 5911 / web 6091 — separate from MISA's :200/5910/6090.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . .env; set +a

PID_DIR="data/run"
LOG_DIR="data/log"
mkdir -p "$PID_DIR" "$LOG_DIR"
chmod 700 data

DISPLAY_NUM="${XVFB_DISPLAY#:}"

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# 1. Xvfb
if is_running "$PID_DIR/xvfb.pid"; then
  echo "[stack] Xvfb already running (pid $(cat $PID_DIR/xvfb.pid))"
else
  if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; then
    echo "[stack] WARN /tmp/.X${DISPLAY_NUM}-lock exists but our pid file does not — refusing to clobber."
    exit 1
  fi
  Xvfb "$XVFB_DISPLAY" -screen 0 1920x1080x24 -ac >"$LOG_DIR/xvfb.log" 2>&1 &
  echo $! > "$PID_DIR/xvfb.pid"
  sleep 0.5
  echo "[stack] Xvfb started on $XVFB_DISPLAY (pid $(cat $PID_DIR/xvfb.pid))"
fi

# 2. x11vnc with password
VNC_PW_FILE="data/secrets/vnc.passwd"
mkdir -p data/secrets
chmod 700 data/secrets
if [ ! -f "$VNC_PW_FILE" ] || ! x11vnc -storepasswd "$VNC_PASSWORD" "$VNC_PW_FILE" >/dev/null 2>&1; then
  x11vnc -storepasswd "$VNC_PASSWORD" "$VNC_PW_FILE" >/dev/null
fi
chmod 600 "$VNC_PW_FILE"

if is_running "$PID_DIR/x11vnc.pid"; then
  echo "[stack] x11vnc already running (pid $(cat $PID_DIR/x11vnc.pid))"
else
  x11vnc -display "$XVFB_DISPLAY" -rfbauth "$VNC_PW_FILE" -forever -shared \
    -rfbport "$VNC_RFB_PORT" -localhost -bg -o "$LOG_DIR/x11vnc.log" >/dev/null
  # x11vnc -bg detaches; find its PID
  sleep 0.5
  pgrep -f "x11vnc -display $XVFB_DISPLAY" | head -1 > "$PID_DIR/x11vnc.pid"
  echo "[stack] x11vnc started on rfbport $VNC_RFB_PORT (pid $(cat $PID_DIR/x11vnc.pid))"
fi

# 3. websockify (noVNC web)
if is_running "$PID_DIR/websockify.pid"; then
  echo "[stack] websockify already running (pid $(cat $PID_DIR/websockify.pid))"
else
  websockify --web /usr/share/novnc "$NOVNC_WEB_PORT" "127.0.0.1:$VNC_RFB_PORT" \
    >"$LOG_DIR/websockify.log" 2>&1 &
  echo $! > "$PID_DIR/websockify.pid"
  sleep 0.5
  echo "[stack] websockify started on http://0.0.0.0:$NOVNC_WEB_PORT (pid $(cat $PID_DIR/websockify.pid))"
fi

echo ""
echo "noVNC URL:    ${NOVNC_PUBLIC_URL:-http://0.0.0.0:$NOVNC_WEB_PORT}/vnc.html?autoconnect=true&resize=scale&password=${VNC_PASSWORD}"
echo "VNC password: ${VNC_PASSWORD}"
echo "Dashboard:    ${APP_PUBLIC_URL:-http://0.0.0.0:$APP_PORT}/"
