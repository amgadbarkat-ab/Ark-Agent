# Ark Link relay (#149). Bun only; no packages are installed. Built from the repository root, because
# the relay imports the wire contract (shared/ark-link.ts) and the store-app files
# (server/src/mobile/links.ts), and nothing else from the repository.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY shared/ark-link.ts shared/
COPY server/src/mobile/links.ts server/src/mobile/
COPY infra/ark-link/relay.ts infra/ark-link/desk-link.ts infra/ark-link/directory.ts infra/ark-link/edge.ts infra/ark-link/pages.ts infra/ark-link/store.ts infra/ark-link/installs.ts infra/ark-link/main.ts infra/ark-link/
RUN mkdir -p /data && chown bun:bun /data
USER bun
WORKDIR /app/infra/ark-link
ENV PORT=8080 LINK_INSTALLS_FILE=/data/installs.json LINK_DEVICES_FILE=/data/devices.json TRUST_PROXY=true
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8080/_link/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "main.ts"]
