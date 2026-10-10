#!/usr/bin/env bash
#
# The Ark Hub: the service that stores conversations and streams runs to the browser.
#
#   bash scripts/hub.sh secrets   make sure the keys exist and the API server is pointed at the hub
#   bash scripts/hub.sh start     start the hub (restarts it if its keys changed) and wait for it
#   bash scripts/hub.sh stop      stop it
#   bash scripts/hub.sh status    say whether it is answering
#
# scripts/start.sh and scripts/stop.sh call this; it is safe to run by hand and safe to repeat.

. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

if [ ! -f "$ROOT/.env" ]; then
  red ".env is missing. Copy .env.example to .env first."
  exit 1
fi

# The environment first, then .env, then the default: the same order as scripts/start.sh.
setting() {
  local name="$1" fallback="$2" value="${!1:-}"
  if [ -z "$value" ]; then
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

# Sets NAME=value in .env, replacing any existing line (including an empty one) and keeping the rest.
set_env() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^$name=" "$ROOT/.env" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  cat "$tmp" > "$ROOT/.env"
  rm -f "$tmp"
}

HUB_PORT="$(setting HUB_PORT 7100)"
PID_FILE="$LOGS/hub.pid"
FINGERPRINT_FILE="$LOGS/hub.fingerprint"

hub_answers() {
  curl -fsS --max-time 3 "http://localhost:$HUB_PORT/health" 2>/dev/null | grep -q '"status":"ok"'
}

# What identifies the keys a running hub was started with, without writing the keys anywhere else.
fingerprint() {
  # openssl rather than sha256sum, which macOS does not ship.
  printf '%s:%s' "$(setting HUB_API_KEY '')" "$(setting HUB_JOIN_SECRET '')" | openssl dgst -sha256 -r | cut -d' ' -f1
}

cmd_secrets() {
  local changed=false
  if [ -z "$(setting HUB_API_KEY '')" ]; then
    set_env HUB_API_KEY "$(openssl rand -base64 32)"
    changed=true
  fi
  if [ -z "$(setting HUB_JOIN_SECRET '')" ]; then
    set_env HUB_JOIN_SECRET "$(openssl rand -base64 32)"
    changed=true
  fi
  # The API server talks to the hub through the settings it already has for a conversation service,
  # so they are pointed at the hub here rather than at anyone else's.
  set_env INTELLIGENCE_API_URL "http://localhost:$HUB_PORT"
  set_env INTELLIGENCE_GATEWAY_WS_URL "ws://localhost:$HUB_PORT"
  set_env INTELLIGENCE_API_KEY "$(setting HUB_API_KEY '')"
  # Ark reports usage to nobody. The server also forces this in code; the file says so too.
  set_env COPILOTKIT_TELEMETRY_DISABLED true
  if [ "$changed" = "true" ]; then
    info "Generated the hub's keys and wrote them to .env."
  fi
}

hub_database_url() {
  local configured app
  configured="$(setting HUB_DATABASE_URL '')"
  if [ -n "$configured" ]; then
    printf '%s' "$configured"
    return
  fi
  # Its own database on the same server as the app's, so a backup of one server covers both.
  app="$(setting DATABASE_URL postgres://openbot:openbot@localhost:5432/openbot)"
  printf '%s/ark_hub' "${app%/*}"
}

stop_hub() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
    fi
    rm -f "$PID_FILE"
  fi
}

cmd_start() {
  cmd_secrets
  if [ -z "$(setting HUB_API_KEY '')" ] || [ -z "$(setting HUB_JOIN_SECRET '')" ]; then
    red "  hub: HUB_API_KEY and HUB_JOIN_SECRET are not set."
    exit 1
  fi

  local want
  want="$(fingerprint)"
  if hub_answers; then
    if [ -f "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE")" = "$want" ]; then
      info "  hub: already up on $HUB_PORT"
      return 0
    fi
    info "  hub: up, but not with the current keys, so it is restarted"
    stop_hub
    sleep 1
  fi
  if hub_answers; then
    red "  hub: port $HUB_PORT answers as a hub this script did not start."
    red "  Stop it yourself, or re-run with HUB_PORT=<free port>."
    exit 1
  fi

  (
    cd "$ROOT"
    HUB_DATABASE_URL="$(hub_database_url)" \
      nohup bun --env-file=.env hub/src/index.ts >"$LOGS/hub.log" 2>&1 &
    echo $! >"$PID_FILE"
  )
  printf '%s' "$want" >"$FINGERPRINT_FILE"

  for _ in $(seq 1 40); do
    if hub_answers; then
      green "  hub ready"
      return 0
    fi
    sleep 1
  done
  red "  hub never answered on port $HUB_PORT."
  red "  Log: $LOGS/hub.log"
  exit 1
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  start)   cmd_start ;;
  stop)    stop_hub; info "  hub stopped" ;;
  status)
    if hub_answers; then
      green "hub answering on $HUB_PORT"
    else
      red "hub not answering on $HUB_PORT"
      exit 1
    fi
    ;;
  *)
    sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
