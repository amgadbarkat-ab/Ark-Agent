# The framework Bot. Same shape as agent-bot and the same absence of a browser: this process speaks
# AG-UI and talks to a model, and the computer it drives is a separate container with its own
# lifecycle. Two Bots in the box rather than one, so "any AG-UI agent is a Bot" is demonstrated by
# two implementations that share nothing but the protocol.
FROM oven/bun:1.3-alpine

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-langgraph/package.json agent-langgraph/bun.lock ./agent-langgraph/
RUN cd agent-langgraph && bun install --frozen-lockfile

# The repo's own layout, kept exactly, so `../../shared/bot-prompt` resolves the same here as it
# does on a laptop. Flattening src to /app/src would change the depth and break only on deploy.
COPY shared ./shared
COPY agent-langgraph/src ./agent-langgraph/src

# How long a call to the model may stay silent before Bun gives up on it, in seconds. Bun's own
# default is five minutes, and a model on a laptop can read its prompt for longer than that before it
# writes a word: the first message to the largest offline model ended with no answer at all.
ENV BUN_CONFIG_HTTP_IDLE_TIMEOUT=1800
ENV PORT=4201
EXPOSE 4201
CMD ["bun", "agent-langgraph/src/index.ts"]
