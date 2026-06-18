#!/usr/bin/env bash
# Wait for Postgres, apply migrations once on a fresh DB, then exec the given command.
set -e

PG_HOST="${PG_HOST:-postgres}"
PG_PORT="${PG_PORT:-5432}"
export PGPASSWORD="$PG_PASSWORD"
PSQL="psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DATABASE"

echo "[entrypoint] waiting for postgres at $PG_HOST:$PG_PORT ..."
until $PSQL -c 'select 1' >/dev/null 2>&1; do sleep 2; done
echo "[entrypoint] postgres is up"

# Fresh DB? (tenants table absent) → apply all migrations in order. They run once;
# the sql/ files are apply-once (no migration tracker yet), so we guard on a sentinel.
HAS_TENANTS="$($PSQL -tAc "select to_regclass('public.tenants')" 2>/dev/null || true)"
if [ -z "$HAS_TENANTS" ]; then
  echo "[entrypoint] fresh database — applying sql/ migrations"
  for f in sql/*.sql; do
    echo "[entrypoint]   $f"
    $PSQL -v ON_ERROR_STOP=1 -f "$f"
  done
  echo "[entrypoint] migrations applied"
else
  echo "[entrypoint] database already initialized — skipping base migrations"
fi

# Patch migrations (numbered >= 023) are applied on EVERY boot. They MUST be
# idempotent (IF NOT EXISTS / IF EXISTS guards) so re-running is a harmless no-op.
# This auto-applies new schema changes to already-initialized DBs without a full
# migration tracker (fixes the "new migration never reaches prod" gap).
for f in sql/*.sql; do
  n="$(basename "$f" | sed -E 's/^0*([0-9]+).*/\1/')"
  if [ "${n:-0}" -ge 23 ] 2>/dev/null; then
    echo "[entrypoint] patch $f"
    $PSQL -v ON_ERROR_STOP=1 -f "$f"
  fi
done

exec "$@"
