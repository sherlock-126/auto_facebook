#!/usr/bin/env bash
# Restart the agent service from the dashboard ("Restart agent" button).
#
# The restart is run via systemd-run (a transient unit in its own cgroup) so that
# stopping auto-facebook-agent — which kills this script's parent (the agent) —
# does not abort the restart job itself.
#
# Usage: restart-agent.sh   (must run as root — invoked via sudo)

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: must be run as root (sudo)."
  exit 1
fi

systemctl stop auto-facebook-agent-login 2>/dev/null || true

if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --collect /bin/systemctl restart auto-facebook-agent >/dev/null 2>&1 \
    || systemctl restart auto-facebook-agent
else
  systemctl restart auto-facebook-agent
fi

echo "OK agent restart requested"
