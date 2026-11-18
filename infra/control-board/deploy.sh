#!/usr/bin/env bash
# BlackArk Control Board (#149): set up and run on the phone relay's VPS. Only after Amgad's yes.
#
#   ./deploy.sh setup          asks for the board's domain, starts it on the relay's network
#   ./deploy.sh checkin        asks (hidden) for the export secret, the same as export_secret on blackark.uk
#   ./deploy.sh github         asks (hidden) for a read-only GitHub token (Issues and Pull requests: read)
#   ./deploy.sh owner          makes the first owner: user name, password at a hidden prompt, 2FA
#   ./deploy.sh reset <user>   a new one-time setup link for someone locked out
#   ./deploy.sh unlock <user> | accounts | verify-audit | status | logs | restart | update
#
# Secrets are typed at hidden prompts and kept in .env (mode 600) on this server only. Never paste
# one into a chat, an issue or a commit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

compose() { docker compose "$@"; }

need_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker with the compose plugin is needed: https://docs.docker.com/engine/install/" >&2
    exit 1
  fi
  if ! docker network inspect phone-relay_default >/dev/null 2>&1; then
    echo "The phone relay's network is not there. Set up infra/phone-relay first (./deploy.sh setup)." >&2
    exit 1
  fi
}

# Replaces the lines starting with $1 in .env with the lines given after it.
set_env() {
  local prefix="$1"; shift
  umask 077
  grep -v "^$prefix" .env > .env.tmp || true
  printf '%s\n' "$@" >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
}

setup() {
  need_docker
  if [[ -f .env ]]; then
    echo ".env already exists; keeping it. Delete it first to start over."
  else
    read -rp "Board domain (DNS A record pointing at this VPS), e.g. board.blackark.uk: " domain
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "That is not a domain name." >&2; exit 1; }
    umask 077
    {
      echo "BOARD_DOMAIN=$domain"
      echo "BOARD_PUBLIC_ORIGIN=https://$domain"
      echo "CHECKIN_EXPORT_URL=https://blackark.uk/checkin/export/"
      echo "RELAY_HEALTH_URL=http://relay:8080/health"
      echo "GITHUB_REPO=amgadbarkat-ab/Ark-Agent"
    } > .env
    chmod 600 .env
  fi
  mkdir -p data
  chmod 700 data
  # The board runs as the image's bun user (uid 1000).
  chown -R 1000:1000 data 2>/dev/null || true
  compose up -d --build
  # shellcheck disable=SC1091
  source .env
  cat <<MSG

The board is running on the relay's network. To serve it at https://$BOARD_DOMAIN:
  1. Add the site in infra/control-board/Caddyfile.board to infra/phone-relay/Caddyfile.
  2. Add  BOARD_DOMAIN: \${BOARD_DOMAIN}  under the caddy service's environment in
     infra/phone-relay/compose.yaml, and BOARD_DOMAIN=$BOARD_DOMAIN to infra/phone-relay/.env.
  3. In infra/phone-relay:  docker compose up -d caddy
Then:  ./deploy.sh checkin   and   ./deploy.sh owner
MSG
}

checkin() {
  [[ -f .env ]] || { echo "Run ./deploy.sh setup first." >&2; exit 1; }
  read -rsp "Export secret, the same as export_secret on blackark.uk (hidden): " secret; echo
  [[ ${#secret} -ge 32 ]] || { echo "The secret is at least 32 characters." >&2; exit 1; }
  set_env CHECKIN_EXPORT_SECRET= "CHECKIN_EXPORT_SECRET=$secret"
  compose up -d
  echo "The board now reads blackark.uk's export."
}

github() {
  [[ -f .env ]] || { echo "Run ./deploy.sh setup first." >&2; exit 1; }
  read -rsp "Fine-grained GitHub token, read-only, this repository only (hidden): " token; echo
  [[ -n "$token" ]] || { echo "The token is empty." >&2; exit 1; }
  set_env GITHUB_TOKEN= "GITHUB_TOKEN=$token"
  compose up -d
  echo "Issues and fixes now reads GitHub."
}

case "${1:-}" in
  setup) setup ;;
  checkin) checkin ;;
  github) github ;;
  owner) compose exec -it board bun cli.ts create-owner ;;
  reset) shift; compose exec board bun cli.ts reset "$@" ;;
  unlock) shift; compose exec board bun cli.ts unlock "$@" ;;
  accounts) compose exec board bun cli.ts list ;;
  verify-audit) compose exec board bun cli.ts verify-audit ;;
  status) compose ps; source .env; curl -fsS "https://$BOARD_DOMAIN/healthz" && echo ;;
  logs) compose logs --tail=200 -f board ;;
  restart) compose restart ;;
  update) compose up -d --build ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
