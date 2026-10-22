# The built-in Bot only speaks AG-UI and a model provider; the browser runs in a separate computer
# container so either side can be replaced independently.
FROM oven/bun:1.3-alpine

WORKDIR /app
RUN chown bun:bun /app
USER bun
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY --chown=bun:bun agent-bot/package.json agent-bot/bun.lock ./agent-bot/
RUN cd agent-bot && bun install --frozen-lockfile

# Preserve the repo layout so `../../shared/bot-prompt` resolves the same in the image and locally.
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun agent-bot/src ./agent-bot/src

# How long a call to the model may stay silent before Bun gives up on it, in seconds. Bun's own
# default is five minutes, and a model on a laptop can read its prompt for longer than that before it
# writes a word: the first message to the largest offline model ended with no answer at all.
ENV BUN_CONFIG_HTTP_IDLE_TIMEOUT=1800
ENV PORT=4200
EXPOSE 4200
CMD ["bun", "agent-bot/src/index.ts"]
