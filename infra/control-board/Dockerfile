# BlackArk Control Board (#149). Build context: the repository root (compose.yaml sets it), so the
# root bun.lock decides every version. No package is added: imapflow and mailparser are the server
# workspace's own, and only they and what they need are copied into the image (about 15 MB).

FROM oven/bun:1.3.14-slim AS mail-deps
WORKDIR /repo
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY hub/package.json hub/package.json
RUN bun install --frozen-lockfile --production --filter ./server --ignore-scripts
COPY infra/control-board/mail-deps.ts /tools/mail-deps.ts
RUN bun /tools/mail-deps.ts /repo /out

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=mail-deps /out/node_modules ./node_modules
COPY infra/control-board/access.ts infra/control-board/accounts.ts infra/control-board/audit.ts infra/control-board/board.ts infra/control-board/board.css infra/control-board/business-hours.ts infra/control-board/cases.ts infra/control-board/cli.ts infra/control-board/html.ts infra/control-board/i18n.ts infra/control-board/intake.ts infra/control-board/mail.ts infra/control-board/pages.ts infra/control-board/roles.ts infra/control-board/server.ts infra/control-board/sources.ts infra/control-board/store.ts infra/control-board/stripe.ts infra/control-board/summary.ts infra/control-board/totp.ts ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8080 BOARD_DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server.ts"]
