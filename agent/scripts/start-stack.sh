#!/usr/bin/env bash
# Start Xvfb + x11vnc + websockify for the agent.
#
# websockify binds to 0.0.0.0:6092 so the customer can open
# http://<their-vps-public-ip>:6092/vnc.html?password=<vnc_pass> directly from
# any browser. Security: VNC password is 32 hex chars (~128 bits entropy),
# brute-force-infeasible. Customer's VPS firewall is responsible for any
# IP-level filtering.
set -euo pipefail

: "${XVFB_DISPLAY:=:202}"
: "${VNC_RFB_PORT:=5912}"
: "${NOVNC_WEB_PORT:=6092}"
: "${VNC_BIND:=0.0.0.0}"
: "${VNC_PASSWD_FILE:=/var/lib/auto-facebook-agent/vnc.passwd}"
: "${NOVNC_DIR:=/usr/share/novnc}"
: "${PID_DIR:=/var/lib/auto-facebook-agent/run}"
: "${LOG_DIR:=/var/log/auto-facebook-agent}"

mkdir -p "$PID_DIR" "$LOG_DIR"

# ----- Xvfb -----
if [ -f "$PID_DIR/xvfb.pid" ] && kill -0 "$(cat "$PID_DIR/xvfb.pid")" 2>/dev/null; then
  echo "[stack] Xvfb already running (pid $(cat "$PID_DIR/xvfb.pid"))"
else
  /usr/bin/Xvfb "$XVFB_DISPLAY" -screen 0 1920x1080x24 -ac \
    > "$LOG_DIR/xvfb.log" 2>&1 &
  echo $! > "$PID_DIR/xvfb.pid"
  sleep 1
  echo "[stack] Xvfb started DISPLAY=$XVFB_DISPLAY pid=$(cat "$PID_DIR/xvfb.pid")"
fi

# ----- x11vnc — still bound to 127.0.0.1; websockify is the public-facing layer -----
if [ -f "$PID_DIR/x11vnc.pid" ] && kill -0 "$(cat "$PID_DIR/x11vnc.pid")" 2>/dev/null; then
  echo "[stack] x11vnc already running"
else
  /usr/bin/x11vnc -display "$XVFB_DISPLAY" -rfbport "$VNC_RFB_PORT" \
    -rfbauth "$VNC_PASSWD_FILE" -localhost \
    -forever -shared -bg -o "$LOG_DIR/x11vnc.log" >/dev/null
  sleep 1
  pgrep -f "x11vnc -display $XVFB_DISPLAY" | head -1 > "$PID_DIR/x11vnc.pid"
  echo "[stack] x11vnc started on 127.0.0.1:$VNC_RFB_PORT pid=$(cat "$PID_DIR/x11vnc.pid")"
fi

# ----- websockify — PUBLIC noVNC web on 0.0.0.0:6092 -----
if [ -f "$PID_DIR/websockify.pid" ] && kill -0 "$(cat "$PID_DIR/websockify.pid")" 2>/dev/null; then
  echo "[stack] websockify already running"
else
  /usr/bin/websockify --web "$NOVNC_DIR" \
    "${VNC_BIND}:$NOVNC_WEB_PORT" "127.0.0.1:$VNC_RFB_PORT" \
    > "$LOG_DIR/websockify.log" 2>&1 &
  echo $! > "$PID_DIR/websockify.pid"
  sleep 1
  echo "[stack] noVNC listening on http://${VNC_BIND}:$NOVNC_WEB_PORT/vnc.html"
fi

echo "[stack] ready"
