#!/usr/bin/env bash
# Creates fb_etl role + fb_warehouse DB on native Postgres (port 5434).
# Idempotent — safe to re-run. Generates a strong random password and writes it to .env if missing.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
fi

# Generate PG password if still default
if grep -q '^PG_PASSWORD=CHANGE_ME' "$ENV_FILE"; then
  PG_PW="$(openssl rand -hex 24)"
  sed -i "s|^PG_PASSWORD=CHANGE_ME|PG_PASSWORD=${PG_PW}|" "$ENV_FILE"
fi
# Generate VNC password if still default (8 chars: VNC limit)
if grep -q '^VNC_PASSWORD=CHANGE_ME' "$ENV_FILE"; then
  VNC_PW="$(openssl rand -hex 4)"
  sed -i "s|^VNC_PASSWORD=CHANGE_ME|VNC_PASSWORD=${VNC_PW}|" "$ENV_FILE"
fi

set -a; . "$ENV_FILE"; set +a

echo "[db] ensuring role $PG_USER and database $PG_DATABASE on port $PG_PORT..."

sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${PG_DATABASE} OWNER ${PG_USER}'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${PG_DATABASE}')\gexec
SQL

echo "[db] applying migrations from sql/..."
for f in sql/*.sql; do
  echo "[db]   $f"
  PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 -f "$f"
done

echo "[db] done. Connection: postgres://${PG_USER}:****@${PG_HOST}:${PG_PORT}/${PG_DATABASE}"
