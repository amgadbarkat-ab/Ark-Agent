#!/usr/bin/env bash
# Put the secrets Ark needs in Azure Key Vault, once, and say which ones only a person can supply.
#
#   scripts/bootstrap-secrets.sh <vault-name> [<database-host>]
#
# IDEMPOTENT. A secret that already exists is left alone, because replacing KEY_ENCRYPTION_KEY would
# make every stored credential unreadable, and replacing the session secret would sign everybody out.
# Rotation is a deliberate act with its own steps (docs/ark/13-azure-hosting.md), never a re-run.
#
# NEVER PRINTS A SECRET. Values go from a generator straight into the vault. The one thing printed is
# which names were created and which are still missing.
#
# Needs `az login` as somebody who holds "Key Vault Secrets Officer" on the vault.

set -euo pipefail

vault="${1:?usage: bootstrap-secrets.sh <vault-name> [<database-host>]}"
database_host="${2:-}"

exists() {
  az keyvault secret show --vault-name "$vault" --name "$1" --query id -o tsv --only-show-errors >/dev/null 2>&1
}

# put <name> <command that prints the value>
put() {
  local name="$1"
  shift
  if exists "$name"; then
    echo "kept     $name"
    return
  fi
  "$@" | az keyvault secret set --vault-name "$vault" --name "$name" --file /dev/stdin \
    --encoding utf-8 --only-show-errors >/dev/null
  echo "created  $name"
}

random_base64() { openssl rand -base64 32 | tr -d '\n'; }
random_hex() { openssl rand -hex 32 | tr -d '\n'; }
# Letters and digits only, so it can sit inside a connection address without escaping.
random_password() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40; }

# What everything stored is encrypted with. Losing this loses every stored credential.
put ark-key-encryption-key random_base64
# Signs sessions (at least 32 characters).
put ark-better-auth-secret random_base64
# The conversation service: what the API presents to it, and what signs a browser's live connection.
put ark-hub-api-key random_base64
put ark-hub-join-secret random_base64
# The shared secret a bot's computer is asked with.
put ark-computer-token random_hex
# What the scheduled-routines job presents to the API.
put ark-worker-shared-secret random_base64
# The database administrator. The password the database was CREATED with, so on a first run it is the
# one given in ARK_POSTGRES_ADMIN_PASSWORD (the deployment needed it before this vault existed), and
# only when none was given is one generated, for a database that has not been made yet.
admin_password() {
  if [ -n "${ARK_POSTGRES_ADMIN_PASSWORD:-}" ]; then
    printf '%s' "$ARK_POSTGRES_ADMIN_PASSWORD"
  else
    random_password
  fi
}
put ark-postgres-admin-password admin_password

if [ -n "$database_host" ]; then
  # Read into a variable of this script and used by the two functions below, so the password is never
  # an argument to any command (arguments are visible to every process on the machine).
  password="$(az keyvault secret show --vault-name "$vault" --name ark-postgres-admin-password --query value -o tsv --only-show-errors)"
  # `arkadmin` matches postgresAdministratorLogin in main.bicep.
  application_url() { printf 'postgres://arkadmin:%s@%s:5432/openbot?sslmode=require' "$password" "$database_host"; }
  hub_url() { printf 'postgres://arkadmin:%s@%s:5432/hub?sslmode=require' "$password" "$database_host"; }
  put ark-database-url application_url
  put ark-hub-database-url hub_url
  unset password
else
  echo "skipped  ark-database-url, ark-hub-database-url (give the database host as the second argument once it exists)"
fi

echo
echo "Only a person can supply these. Set each with:"
echo "  az keyvault secret set --vault-name $vault --name <name> --value '<value>'"
missing=0
for name in \
  ark-google-client-secret \
  ark-microsoft-client-secret \
  ark-paddle-api-key \
  ark-paddle-webhook-secret; do
  if exists "$name"; then
    echo "  ok       $name"
  else
    echo "  MISSING  $name"
    missing=1
  fi
done
exit "$missing"
