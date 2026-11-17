#!/usr/bin/env bash
# BlackArk phone relay (#109): set up and run on any Linux VPS with Docker.
#
#   ./deploy.sh setup                          asks for the domain and the Twilio account, starts it
#   ./deploy.sh add-line <name> <+number> [<+fallback>]   adds a line, prints its token once
#   ./deploy.sh bill-line <name> <customer-id|none>   pays the line from that prepaid balance
#   ./deploy.sh billing                        asks (hidden) for the prepaid balance's shared secret
#   ./deploy.sh remove-line <name>
#   ./deploy.sh lines | status | logs | restart | update
#
# The Twilio auth token is typed at a hidden prompt and kept in .env (mode 600) on this server.
# Never paste it into a chat, an issue or a commit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

compose() { docker compose "$@"; }

need_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker with the compose plugin is needed: https://docs.docker.com/engine/install/" >&2
    exit 1
  fi
}

setup() {
  need_docker
  if [[ -f .env ]]; then
    echo ".env already exists; keeping it. Delete it first to start over."
  else
    read -rp "Relay domain (DNS A record pointing here), e.g. phone.blackark.uk: " domain
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "That is not a domain name." >&2; exit 1; }
    read -rp "Twilio Account SID (starts AC): " sid
    [[ "$sid" =~ ^AC[0-9a-f]{32}$ ]] || { echo "That is not an Account SID." >&2; exit 1; }
    read -rsp "Twilio auth token (hidden): " token; echo
    [[ -n "$token" ]] || { echo "The auth token is empty." >&2; exit 1; }
    umask 077
    {
      echo "RELAY_DOMAIN=$domain"
      echo "PUBLIC_BASE_URL=https://$domain"
      echo "TWILIO_ACCOUNT_SID=$sid"
      echo "TWILIO_AUTH_TOKEN=$token"
    } > .env
    chmod 600 .env
  fi
  mkdir -p data
  [[ -f data/lines.json ]] || echo '{"lines":[]}' > data/lines.json
  chmod 700 data
  # The relay runs as the image's bun user (uid 1000).
  chown -R 1000:1000 data 2>/dev/null || true
  compose up -d --build
  # shellcheck disable=SC1091
  source .env
  cat <<MSG

Relay started. In the Twilio console, for each number:
  A call comes in:  Webhook  https://$RELAY_DOMAIN/twilio/voice   (HTTP POST)
  Call status changes:       https://$RELAY_DOMAIN/twilio/status  (HTTP POST)
Then add the line here:  ./deploy.sh add-line <name> <+twilio-number> [<+fallback-number>]
Check:  curl -fsS https://$RELAY_DOMAIN/health   (answers ok once the certificate is issued)
MSG
}

# The prepaid phone balance (v0.1.47): where it is kept, and the secret the relay signs with. The
# secret is the same as relay_secret in blackark.uk's checkin/config.php, typed at a hidden prompt.
billing() {
  [[ -f .env ]] || { echo "Run ./deploy.sh setup first." >&2; exit 1; }
  read -rsp "Prepaid balance secret, the same as relay_secret on blackark.uk (hidden): " secret; echo
  [[ ${#secret} -ge 32 ]] || { echo "The secret is at least 32 characters." >&2; exit 1; }
  umask 077
  grep -v '^BILLING_' .env > .env.tmp || true
  {
    echo "BILLING_URL=https://blackark.uk/checkin/phone/"
    echo "BILLING_SECRET=$secret"
  } >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
  compose up -d
  echo "Billing is on. Bill a line with:  ./deploy.sh bill-line <name> <customer-id>"
  echo "In the Twilio console nothing changes."
}

case "${1:-}" in
  setup) setup ;;
  billing) billing ;;
  bill-line) shift; compose exec relay bun lines.ts bill "$@" ;;
  add-line) shift; compose exec relay bun lines.ts add "$@" ;;
  remove-line) shift; compose exec relay bun lines.ts remove "$@" ;;
  lines) compose exec relay bun lines.ts list ;;
  status) compose ps; source .env; curl -fsS "https://$RELAY_DOMAIN/health" && echo ;;
  logs) compose logs --tail=200 -f relay ;;
  restart) compose restart ;;
  update) compose up -d --build ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
