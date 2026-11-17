#!/bin/sh
# Migrations, for the embedded database only.
#
# An external database is somebody else's release process: two replicas starting together would
# race, and a failed migration should stop a deploy rather than leave a half-migrated database
# serving. An embedded one has exactly one process and no deploy pipeline, so doing it here is the
# difference between the container working and the operator reading a runbook.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0
# Wait until the database accepts connections. `postgres` is a longrun with no readiness
# notification, so s6 starts this the moment the server process exists, not when it can answer: on a
# slow or busy host the migration then meets "the database system is starting up" (57P03), exits 1,
# and `api` never starts. pg_isready ships with postgresql-16 in this image.
tries=0
until /usr/lib/postgresql/16/bin/pg_isready -q -h 127.0.0.1 -p 5432; do
  tries=$((tries + 1))
  if [ "$tries" -ge 240 ]; then
    echo "migrate: the embedded database did not accept connections within 120 seconds." >&2
    exit 1
  fi
  sleep 0.5
done
cd /app/server
export HOME=/home/apiuser
# `scripts/migrate.ts`, not `drizzle-kit`. The CLI is a development dependency and needs esbuild to
# read its TypeScript config, which `bun install --production` leaves out of this image: asked to
# migrate here it exits 1 without printing why, and the container comes up against an empty database.
exec s6-setuidgid apiuser /usr/local/bin/bun scripts/migrate.ts
