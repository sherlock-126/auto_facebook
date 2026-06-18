#!/usr/bin/env bash
# Build the agent tarball that customers download via install.sh.
# Output: data/dist/agent-latest.tgz
#
# Tarball contents (relative to agent/):
#   package.json
#   src/index.js, src/heartbeat.js, src/config.js, src/version.js
#   systemd/auto-facebook-agent.service
#   install.sh
#
# install.sh inside the tarball still contains the __CLOUD_BASE_URL__ placeholder.
# The cloud's /install.sh route templates it at request time before sending to
# customer — so the tarball itself stays cloud-agnostic.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="data/dist"
OUT_TGZ="$OUT_DIR/latest.tgz"

mkdir -p "$OUT_DIR"

# --exclude node_modules in case anyone ran `npm install` inside agent/ during dev.
tar -czf "$OUT_TGZ" \
  --exclude='node_modules' \
  --exclude='.DS_Store' \
  -C agent \
  package.json tsconfig.json src systemd scripts install.sh

SIZE=$(stat -c%s "$OUT_TGZ" 2>/dev/null || stat -f%z "$OUT_TGZ")
echo "✓ built $OUT_TGZ ($SIZE bytes)"
