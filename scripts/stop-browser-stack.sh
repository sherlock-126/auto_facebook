#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PID_DIR="data/run"

for name in websockify x11vnc xvfb; do
  f="$PID_DIR/$name.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stack] stopping $name (pid $pid)"
      kill "$pid" || true
    fi
    rm -f "$f"
  fi
done
