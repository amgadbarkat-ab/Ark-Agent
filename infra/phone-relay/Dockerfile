# BlackArk phone relay (#109). Bun only; no packages are installed.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY relay.ts lines.ts ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8080 RELAY_LINES_FILE=/data/lines.json
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "relay.ts"]
