#!/usr/bin/env bash
# Ark Link relay (#149): set up and run on any Linux VPS with Docker. NOT DEPLOYED: needs Amgad's yes.
#
#   ./deploy.sh setup                 asks for the domain (and, optionally, the store apps), starts it
#   ./deploy.sh add-install <id>      adds a customer's desktop, prints its install token once
#   ./deploy.sh remove-install <id>   that desktop can no longer connect; its phones see "offline"
#   ./deploy.sh installs | status | logs | restart | update
#
# The relay holds no secret of its own: install and device tokens are kept as SHA-256 only. The
# install token is shown once, for the administrator at that desktop. Never paste it into a chat, an
# issue or a commit.
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
    read -rp "Link domain (DNS A record pointing here), e.g. link.blackark.uk: " domain
    [[ "$domain" =~ ^[a-z0-9.-]+$ ]] || { echo "That is not a domain name (lower case)." >&2; exit 1; }
    read -rp "Android package for assetlinks.json (Enter to skip), e.g. blackark.arkagent: " android
    fingerprints=""
    if [[ -n "$android" ]]; then
      read -rp "App signing key SHA-256 fingerprint(s), comma-separated (from Play Console): " fingerprints
    fi
    read -rp "iOS app id for apple-app-site-association (TEAMID.bundle; Enter to skip): " ios
    umask 077
    {
      echo "LINK_DOMAIN=$domain"
      echo "LINK_ORIGIN=https://$domain"
      [[ -n "$android" ]] && echo "ARK_ANDROID_APP_ID=$android"
      [[ -n "$fingerprints" ]] && echo "ARK_ANDROID_CERT_SHA256=$fingerprints"
      [[ -n "$ios" ]] && echo "ARK_IOS_APP_ID=$ios"
      true
    } > .env
    chmod 600 .env
  fi
  mkdir -p data
  [[ -f data/installs.json ]] || echo '{"installs":[]}' > data/installs.json
  [[ -f data/devices.json ]] || echo '{"devices":[]}' > data/devices.json
  chmod 700 data
  # The relay runs as the image's bun user (uid 1000).
  chown -R 1000:1000 data 2>/dev/null || true
  compose up -d --build
  # shellcheck disable=SC1091
  source .env
  cat <<MSG

Relay started. Add a customer's desktop:  ./deploy.sh add-install <id>
Check:  curl -fsS https://$LINK_DOMAIN/_link/health   (answers ok once the certificate is issued)
MSG
}

case "${1:-}" in
  setup) setup ;;
  add-install) shift; compose exec relay bun installs.ts add "$@" ;;
  remove-install) shift; compose exec relay bun installs.ts remove "$@" ;;
  installs) compose exec relay bun installs.ts list ;;
  status) compose ps; source .env; curl -fsS "https://$LINK_DOMAIN/_link/health" && echo ;;
  logs) compose logs --tail=200 -f relay ;;
  restart) compose restart ;;
  update) compose up -d --build ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
