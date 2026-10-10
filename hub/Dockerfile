# Ark Hub: the conversation service, in its own small image.
#
# The browser, the API server and every run talk to it, and it keeps every conversation, so it is a
# service of its own with a database of its own (`HUB_DATABASE_URL`), separate from the application's.
# See hub/README.md for what it does and how it is configured.
#
# SEVERAL PROCESSES ARE FINE. Live events move between sockets through PostgreSQL (`HUB_BUS=postgres`,
# the default; hub/src/shared-bus.ts), so a second replica or a rolling update does not split a
# conversation's live stream. `HUB_BUS=memory` keeps them in one process and is right for exactly one.
#
# Build from the repository root:  docker build -f hub/Dockerfile -t ark-hub .

FROM oven/bun:1.3.14 AS deps

WORKDIR /app

# The hub is a workspace of the root manifest, and a frozen install needs every workspace's manifest
# present or it refuses with `Workspace not found`. Only the hub's dependencies are installed, and
# only the ones it runs on: the SDK packages its tests drive are development dependencies.
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY hub/package.json hub/package.json
RUN bun install --frozen-lockfile --production --filter hub


FROM oven/bun:1.3.14 AS runtime

# Not root: it opens a socket and talks to Postgres, and needs nothing more.
RUN groupadd --system --gid 1001 ark \
  && useradd --system --uid 1001 --gid ark ark

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY hub/package.json hub/package.json
COPY hub/src hub/src
# The counters and the text a scraper reads them as, and how to leave without cutting anybody off:
# shared with the API server.
COPY shared/metrics.ts shared/drain.ts shared/readiness.ts shared/
# Applied on start, in order, each once.
COPY hub/migrations hub/migrations

USER ark:ark

ENV NODE_ENV=production
ENV HUB_PORT=7100
EXPOSE 7100

# `/health` answers without touching the database, so this says the process is up, not that Postgres is.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=4 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.HUB_PORT ?? 7100}/health`); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "hub/src/index.ts"]
