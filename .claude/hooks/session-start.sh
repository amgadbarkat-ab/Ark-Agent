#!/bin/bash
# Gets a Claude Code on the web session ready to build and test Ark:
#   - the pinned Bun, and every workspace's dependencies
#   - a local PostgreSQL with pgvector and a migrated test database, for the integration tests
#
# Web sessions only, safe to run again, never asks anything. It does not start Docker (the unit and
# integration tests do not need it) and does not create `.env`, which holds secrets.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

log() { printf 'session-start: %s\n' "$*"; }

# --- Bun ---------------------------------------------------------------------------------------
WANT_BUN="$(sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p' package.json | head -1)"
HAVE_BUN="$(bun --version 2>/dev/null || true)"
if [ -n "$WANT_BUN" ] && [ "$HAVE_BUN" != "$WANT_BUN" ]; then
  log "installing bun $WANT_BUN (found: ${HAVE_BUN:-none})"
  npm install -g "bun@$WANT_BUN" >/dev/null 2>&1
fi

# --- Dependencies ------------------------------------------------------------------------------
log "installing dependencies"
bun install >/dev/null
# Two services are not workspaces and carry their own manifests.
for dir in agent-langgraph agent-bot; do
  if [ -f "$dir/package.json" ]; then (cd "$dir" && bun install >/dev/null); fi
done

# --- PostgreSQL for the integration tests ------------------------------------------------------
# Failures here are reported but do not stop the session: most work does not need a database.
setup_postgres() {
  command -v pg_lsclusters >/dev/null 2>&1 || { log "no local PostgreSQL; skipping database setup"; return 0; }
  local version cluster
  read -r version cluster _ < <(pg_lsclusters -h | head -1) || true
  [ -n "${version:-}" ] || { log "no PostgreSQL cluster; skipping database setup"; return 0; }

  if [ ! -f "/usr/share/postgresql/$version/extension/vector.control" ]; then
    log "installing pgvector for PostgreSQL $version"
    apt-get install -y "postgresql-$version-pgvector" >/dev/null 2>&1 || log "could not install pgvector"
  fi

  pg_lsclusters -h | awk '{print $4}' | grep -q online || pg_ctlcluster "$version" "$cluster" start
  for _ in $(seq 1 30); do
    su postgres -c "psql -tAc 'select 1'" >/dev/null 2>&1 && break
    sleep 1
  done

  su postgres -c "psql -v ON_ERROR_STOP=1" >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ark') THEN
    CREATE ROLE ark LOGIN SUPERUSER PASSWORD 'ark';
  END IF;
END $$;
SELECT 'CREATE DATABASE ark_test OWNER ark' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ark_test')\gexec
SQL

  export TEST_DATABASE_URL="postgres://ark:ark@127.0.0.1:5432/ark_test"
  DATABASE_URL="$TEST_DATABASE_URL" bun server/scripts/migrate.ts >/dev/null
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export TEST_DATABASE_URL=\"$TEST_DATABASE_URL\"" >> "$CLAUDE_ENV_FILE"
  fi
  log "PostgreSQL ready; TEST_DATABASE_URL is set"
}
setup_postgres || log "database setup failed; integration tests will not run"

log "done"
