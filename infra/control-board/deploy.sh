#!/usr/bin/env bash
# BlackArk Control Board (#149): set up and run on BlackArk's Oracle Always Free VM, behind
# Cloudflare Tunnel and Access. Only after Amgad's yes. The board publishes no port.
#
#   ./deploy.sh setup          asks for the board's address; writes .env; builds (does not start yet)
#   ./deploy.sh tunnel         asks (hidden) for the Cloudflare Tunnel token; starts board + cloudflared
#   ./deploy.sh access         asks for the Access team domain and the application's AUD tag (not secret)
#   ./deploy.sh checkin        asks (hidden) for the export secret, the same as export_secret on blackark.uk
#   ./deploy.sh intake         asks (hidden) for the Help & support secret, the same as intake_secret on blackark.uk
#   ./deploy.sh stripe         asks (hidden) for Stripe's restricted read-only key
#   ./deploy.sh github         asks (hidden) for a read-only GitHub token (Issues and Pull requests: read)
#   ./deploy.sh mailbox        asks for General@'s IMAP sign-in (password hidden); support@ mail only is read
#   ./deploy.sh holidays       sets the days off besides weekends (YYYY-MM-DD,YYYY-MM-DD)
#   ./deploy.sh owner          makes the first owner: user name, password at a hidden prompt, 2FA
#   ./deploy.sh reset <user>   a new one-time setup link for someone locked out
#   ./deploy.sh unlock <user> | accounts | verify-audit | status | logs | restart | update
#
# Secrets are typed at hidden prompts and kept in .env or tunnel.env (mode 600) on this VM only.
# Never paste one into a chat, an issue or a commit.
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

need_env() { [[ -f .env ]] || { echo "Run ./deploy.sh setup first." >&2; exit 1; }; }

# Replaces the lines starting with $2 in file $1 with the lines given after them.
set_in() {
  local file="$1" prefix="$2"; shift 2
  umask 077
  touch "$file"
  grep -v "^$prefix" "$file" > "$file.tmp" || true
  printf '%s\n' "$@" >> "$file.tmp"
  mv "$file.tmp" "$file"
  chmod 600 "$file"
}

hidden() { # prompt, minimum length -> the value on stdout
  local value
  read -rsp "$1" value; echo >&2
  [[ ${#value} -ge $2 ]] || { echo "That is shorter than $2 characters." >&2; exit 1; }
  printf '%s' "$value"
}

running() { [[ -f tunnel.env ]] && compose up -d; }

setup() {
  need_docker
  if [[ -f .env ]]; then
    echo ".env already exists; keeping it. Delete it first to start over."
  else
    read -rp "Board address (the Cloudflare Tunnel public hostname), e.g. board.blackark.uk: " domain
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "That is not a domain name." >&2; exit 1; }
    umask 077
    {
      echo "BOARD_PUBLIC_ORIGIN=https://$domain"
      echo "CHECKIN_EXPORT_URL=https://blackark.uk/checkin/export/"
      echo "RELAY_HEALTH_URL=https://phone.blackark.uk/health"
      echo "GITHUB_REPO=amgadbarkat-ab/Ark-Agent"
    } > .env
    chmod 600 .env
  fi
  mkdir -p data
  chmod 700 data
  # The board runs as the image's bun user (uid 1000).
  chown -R 1000:1000 data 2>/dev/null || true
  compose build board
  cat <<'MSG'

Built. Next, in this order:
  ./deploy.sh tunnel     the Cloudflare Tunnel token (starts the board and cloudflared)
  ./deploy.sh access     the Access team domain and AUD tag, so requests around the tunnel are refused
  ./deploy.sh checkin    the export secret
  ./deploy.sh owner      the first owner
MSG
}

tunnel() {
  need_docker; need_env
  local token
  token="$(hidden "Cloudflare Tunnel token (hidden): " 40)"
  set_in tunnel.env TUNNEL_TOKEN= "TUNNEL_TOKEN=$token"
  compose up -d
  echo "The board and cloudflared are running. The board has no public port."
}

access() {
  need_env
  read -rp "Cloudflare Access team domain, e.g. blackark.cloudflareaccess.com: " team
  [[ "$team" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] || { echo "That is not a team domain." >&2; exit 1; }
  read -rp "The board application's Application Audience (AUD) tag: " aud
  [[ "$aud" =~ ^[A-Za-z0-9]{32,128}$ ]] || { echo "That is not an AUD tag." >&2; exit 1; }
  set_in .env CF_ACCESS_ "CF_ACCESS_TEAM_DOMAIN=$team" "CF_ACCESS_AUD=$aud"
  running || true
  echo "Requests without Cloudflare Access's signed header are now refused."
}

secret_setting() { # name, prompt, minimum length
  need_env
  local value
  value="$(hidden "$2" "$3")"
  set_in .env "$1=" "$1=$value"
  running || true
}

mailbox() {
  need_env
  read -rp "IMAP server [imap.one.com]: " host; host="${host:-imap.one.com}"
  read -rp "IMAP port [993]: " port; port="${port:-993}"
  read -rp "Mailbox user [General@blackark.uk]: " user; user="${user:-General@blackark.uk}"
  local password
  password="$(hidden "That mailbox's password (hidden): " 1)"
  set_in .env MAIL_ "MAIL_IMAP_HOST=$host" "MAIL_IMAP_PORT=$port" "MAIL_USER=$user" "MAIL_PASSWORD=$password"
  set_in .env SUPPORT_ADDRESS= "SUPPORT_ADDRESS=support@blackark.uk"
  running || true
  echo "Only mail sent to support@blackark.uk is read; everything else in $user stays unread."
}

holidays() {
  need_env
  read -rp "Days off besides weekends (YYYY-MM-DD,YYYY-MM-DD): " days
  [[ "$days" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})?(,[0-9]{4}-[0-9]{2}-[0-9]{2})*$ ]] || { echo "Not a list of dates." >&2; exit 1; }
  set_in .env BOARD_HOLIDAYS= "BOARD_HOLIDAYS=$days"
  running || true
}

case "${1:-}" in
  setup) setup ;;
  tunnel) tunnel ;;
  access) access ;;
  checkin) secret_setting CHECKIN_EXPORT_SECRET "Export secret, the same as export_secret on blackark.uk (hidden): " 32 ;;
  intake) secret_setting INTAKE_SECRET "Help & support secret, the same as intake_secret on blackark.uk (hidden): " 32 ;;
  stripe) secret_setting STRIPE_READ_KEY "Stripe restricted key, read-only (rk_live_..., hidden): " 20 ;;
  github) secret_setting GITHUB_TOKEN "Fine-grained GitHub token, read-only, this repository only (hidden): " 20 ;;
  mailbox) mailbox ;;
  holidays) holidays ;;
  owner) compose exec -it board bun cli.ts create-owner ;;
  reset) shift; compose exec board bun cli.ts reset "$@" ;;
  unlock) shift; compose exec board bun cli.ts unlock "$@" ;;
  accounts) compose exec board bun cli.ts list ;;
  verify-audit) compose exec board bun cli.ts verify-audit ;;
  status) compose ps; compose exec board bun -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>console.log(await r.text()))" ;;
  logs) compose logs --tail=200 -f board ;;
  restart) compose restart ;;
  update) compose build board && compose up -d ;;
  *) sed -n '2,19p' "$0"; exit 1 ;;
esac
