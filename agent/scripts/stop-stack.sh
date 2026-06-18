#!/usr/bin/env bash
set -euo pipefail
PID_DIR="${PID_DIR:-/var/lib/auto-facebook-agent/run}"
for p in websockify x11vnc xvfb; do
  if [ -f "$PID_DIR/$p.pid" ]; then
    pid=$(cat "$PID_DIR/$p.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "[stack] stopped $p (pid $pid)"
    fi
    rm -f "$PID_DIR/$p.pid"
  fi
done
