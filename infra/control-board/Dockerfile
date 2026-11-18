# BlackArk Control Board (#149). Bun only; no packages are installed.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY accounts.ts audit.ts board.ts board.css cli.ts html.ts i18n.ts pages.ts roles.ts server.ts sources.ts store.ts summary.ts totp.ts ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8080 BOARD_DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server.ts"]
