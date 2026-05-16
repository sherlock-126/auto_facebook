#!/usr/bin/env bash
# Smoke test: verify all moving parts are alive and reachable.
# Usage: bash scripts/smoke-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . .env; set +a

pass=0
fail=0
PASS()  { echo "  [PASS] $1"; pass=$((pass+1)); }
FAIL()  { echo "  [FAIL] $1"; fail=$((fail+1)); }
SKIP()  { echo "  [SKIP] $1"; }

echo ""
echo "=== 1. Process / port checks ==="

for port in "$APP_PORT" "$NOVNC_WEB_PORT" "$VNC_RFB_PORT"; do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$"; then
    PASS "port $port listening"
  else
    FAIL "port $port not listening"
  fi
done

DISPLAY_NUM="${XVFB_DISPLAY#:}"
if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; then
  PASS "Xvfb display $XVFB_DISPLAY has lock file"
else
  FAIL "Xvfb display $XVFB_DISPLAY missing lock file"
fi

echo ""
echo "=== 2. HTTP endpoints ==="

if curl -fsS "http://127.0.0.1:${APP_PORT}/api/dashboard/stats" >/dev/null 2>&1; then
  PASS "dashboard/stats responds 2xx"
else
  FAIL "dashboard/stats unreachable on :${APP_PORT}"
fi

if curl -fsS "http://127.0.0.1:${APP_PORT}/" -o /dev/null 2>&1; then
  PASS "dashboard HTML serves"
else
  FAIL "dashboard / unreachable"
fi

if curl -fsS "http://127.0.0.1:${NOVNC_WEB_PORT}/vnc.html" -o /dev/null 2>&1; then
  PASS "noVNC web serves vnc.html on :${NOVNC_WEB_PORT}"
else
  FAIL "noVNC web not serving"
fi

echo ""
echo "=== 3. Postgres connectivity ==="
export PGPASSWORD="$PG_PASSWORD"
if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tc "SELECT 1" >/dev/null 2>&1; then
  PASS "psql connect $PG_USER@$PG_HOST:$PG_PORT/$PG_DATABASE"
else
  FAIL "psql connect failed"
fi

for t in fb_session fb_auth_context dim_group dim_user fact_group_post fact_group_post_comment etl_watermark etl_run xhr_capture fb_request_budget; do
  if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tc "SELECT to_regclass('public.$t')" 2>/dev/null | grep -q "$t"; then
    PASS "table $t exists"
  else
    FAIL "table $t missing"
  fi
done

echo ""
echo "=== 4. Cloudflare tunnel (best-effort) ==="
if [ -n "${APP_PUBLIC_URL:-}" ]; then
  if curl -fsS --max-time 8 "$APP_PUBLIC_URL/api/dashboard/stats" -o /dev/null 2>&1; then
    PASS "$APP_PUBLIC_URL reachable"
  else
    FAIL "$APP_PUBLIC_URL not reachable from this host (DNS/tunnel?)"
  fi
fi
if [ -n "${NOVNC_PUBLIC_URL:-}" ]; then
  if curl -fsS --max-time 8 "$NOVNC_PUBLIC_URL/vnc.html" -o /dev/null 2>&1; then
    PASS "$NOVNC_PUBLIC_URL reachable"
  else
    FAIL "$NOVNC_PUBLIC_URL not reachable (DNS/tunnel?)"
  fi
fi

echo ""
echo "=== 5. Session / capture state ==="
SESS=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tc "SELECT count(*) FROM fb_session WHERE is_active = TRUE" 2>/dev/null | tr -d ' ')
if [ "${SESS:-0}" -gt 0 ]; then
  PASS "$SESS active fb_session row(s)"
else
  SKIP "no active session yet — log in via dashboard"
fi

GRP=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tc "SELECT count(*) FROM dim_group WHERE is_joined = TRUE" 2>/dev/null | tr -d ' ')
if [ "${GRP:-0}" -gt 0 ]; then
  PASS "$GRP joined group row(s) discovered"
else
  SKIP "no joined groups yet — run fb_joined_groups entity after wiring discover"
fi

XHR=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tc "SELECT count(*) FROM xhr_capture" 2>/dev/null | tr -d ' ')
SKIP "xhr_capture has ${XHR:-0} row(s)"

echo ""
echo "=== Summary: $pass pass / $fail fail ==="
if [ -n "${APP_PUBLIC_URL:-}" ]; then
  echo ""
  echo "Dashboard : $APP_PUBLIC_URL"
fi
if [ -n "${NOVNC_PUBLIC_URL:-}" ]; then
  echo "noVNC     : $NOVNC_PUBLIC_URL/vnc.html?autoconnect=true&resize=scale&password=$VNC_PASSWORD"
fi

[ "$fail" -eq 0 ]
