#!/usr/bin/env bash
# Create the identities Ark needs in Microsoft Entra ID, once. Safe to run again.
#
#   scripts/setup-identity.sh create <public-url> <github-owner/repo> [<key-vault-name>]
#   scripts/setup-identity.sh grant  <resource-group>
#
# `create` is run BEFORE the infrastructure and makes:
#   1. "Ark staff sign-in"   the application staff sign in with (single directory, never `common`;
#                            see docs/ark/15-security-review.md F1), with the `email` claim Ark needs.
#   2. "Ark cluster admins"  the group whose members administer the cluster.
#   3. "ark-deploy"          the identity the GitHub pipeline signs in as, trusted by the repository's
#                            `dev` and `prod` environments. It holds no password.
# and prints what to put in main.<env>.bicepparam and the repository variables. If a vault name is
# given AND it exists, the staff application's client secret goes straight into it; otherwise run
# `create` again with the vault name once the infrastructure is up (it adds only what is missing).
#
# `grant` is run AFTER the infrastructure and gives ark-deploy the least it needs (13-azure-hosting.md).
#
# NEVER PRINTS A SECRET. Needs `az login` as somebody who may register applications and create groups
# in the directory, and (for `grant`) own the resource group.

set -euo pipefail

mode="${1:?usage: setup-identity.sh create <public-url> <owner/repo> [<vault>] | grant <resource-group>}"

find_app() { az ad app list --display-name "$1" --query "[0].appId" -o tsv --only-show-errors; }

# The Microsoft Graph application id, and the id of its delegated "User.Read" permission: what lets
# the application read the signed-in person's own profile, and nothing else.
GRAPH=00000003-0000-0000-c000-000000000000
USER_READ=e1fe6dd8-ba31-4d61-89e7-88639da4683d

case "$mode" in
create)
  url="${2:?public url, e.g. https://ark.example.com}"
  repo="${3:?GitHub repository, owner/name}"
  vault="${4:-}"
  url="${url%/}"
  case "$url" in https://*) ;; *) echo "The public address must be https." >&2; exit 2 ;; esac
  tenant="$(az account show --query tenantId -o tsv --only-show-errors)"

  # 1. Staff sign-in. AzureADMyOrg is what makes the directory id in the configuration a real
  #    boundary: only this directory's accounts can sign in, and only this directory writes the address.
  staff="$(find_app 'Ark staff sign-in')"
  if [ -z "$staff" ]; then
    staff="$(az ad app create --display-name 'Ark staff sign-in' \
      --sign-in-audience AzureADMyOrg \
      --web-redirect-uris "$url/api/auth/callback/microsoft" \
      --optional-claims '{"idToken":[{"name":"email","essential":false}]}' \
      --required-resource-accesses "[{\"resourceAppId\":\"$GRAPH\",\"resourceAccess\":[{\"id\":\"$USER_READ\",\"type\":\"Scope\"}]}]" \
      --query appId -o tsv --only-show-errors)"
    az ad sp create --id "$staff" --only-show-errors --output none
    echo "created  Ark staff sign-in"
  else
    echo "kept     Ark staff sign-in"
  fi

  if [ -n "$vault" ]; then
    if az keyvault secret show --vault-name "$vault" --name ark-microsoft-client-secret \
         --query id -o tsv --only-show-errors >/dev/null 2>&1; then
      echo "kept     ark-microsoft-client-secret (already in the vault)"
    else
      # --append: never throws away a secret that is in use somewhere. The value goes from Entra into
      # the vault and is not held in a variable that outlives the pipe.
      az ad app credential reset --id "$staff" --append --display-name "ark-$(date +%Y%m%d)" \
          --years 1 --query password -o tsv --only-show-errors \
        | tr -d '\n' \
        | az keyvault secret set --vault-name "$vault" --name ark-microsoft-client-secret \
            --file /dev/stdin --encoding utf-8 --only-show-errors --output none
      echo "created  ark-microsoft-client-secret (expires in a year: put the date in the calendar)"
    fi
  fi

  # 2. Cluster administrators.
  group="$(az ad group list --display-name 'Ark cluster admins' --query "[0].id" -o tsv --only-show-errors)"
  if [ -z "$group" ]; then
    group="$(az ad group create --display-name 'Ark cluster admins' --mail-nickname ark-cluster-admins \
      --query id -o tsv --only-show-errors)"
    me="$(az ad signed-in-user show --query id -o tsv --only-show-errors 2>/dev/null || true)"
    if [ -n "$me" ]; then
      az group member add --group "$group" --member-id "$me" --only-show-errors 2>/dev/null || true
    fi
    echo "created  Ark cluster admins (you are a member)"
  else
    echo "kept     Ark cluster admins"
  fi

  # 3. The pipeline. No secret exists for it: GitHub proves who the run is, Entra trusts that.
  deploy="$(find_app ark-deploy)"
  if [ -z "$deploy" ]; then
    deploy="$(az ad app create --display-name ark-deploy --query appId -o tsv --only-show-errors)"
    az ad sp create --id "$deploy" --only-show-errors --output none
    echo "created  ark-deploy"
  else
    echo "kept     ark-deploy"
  fi
  existing="$(az ad app federated-credential list --id "$deploy" --query "[].name" -o tsv --only-show-errors)"
  for environment in dev prod; do
    if ! printf '%s\n' "$existing" | grep -qx "ark-$environment"; then
      az ad app federated-credential create --id "$deploy" --only-show-errors --output none --parameters "{
        \"name\": \"ark-$environment\",
        \"issuer\": \"https://token.actions.githubusercontent.com\",
        \"subject\": \"repo:$repo:environment:$environment\",
        \"audiences\": [\"api://AzureADTokenExchange\"]}"
      echo "created  trust for the $environment environment of $repo"
    fi
  done

  cat <<SUMMARY

Put these where they belong (none is a secret):

  main.<env>.bicepparam      adminGroupObjectId = '$group'
  values-azure.yaml          config.auth.microsoft.clientId = $staff
                             config.auth.microsoft.tenantId = $tenant
  repository variables       AZURE_CLIENT_ID = $deploy
                             AZURE_TENANT_ID = $tenant
                             AZURE_SUBSCRIPTION_ID = $(az account show --query id -o tsv --only-show-errors)
                             AZURE_RESOURCE_GROUP = rg-ark-<env>

Customer sign-in with Google cannot be created from here: Google offers no way to make a web sign-in
client except its console. The steps are in infra/azure/README.md (Google).
SUMMARY
  ;;

grant)
  group="${2:?resource group, e.g. rg-ark-prod}"
  deploy="$(find_app ark-deploy)"
  [ -n "$deploy" ] || { echo "Run 'create' first." >&2; exit 1; }
  out() { az deployment group show -g "$group" -n main --query "properties.outputs.$1.value" -o tsv --only-show-errors; }
  rg_id="$(az group show -n "$group" --query id -o tsv --only-show-errors)"
  registry_id="$(az acr show -n "$(out registryName)" --query id -o tsv --only-show-errors)"
  cluster_id="$(az aks show -g "$group" -n "$(out clusterName)" --query id -o tsv --only-show-errors)"

  assign() { # <role> <scope>
    if [ -z "$(az role assignment list --assignee "$deploy" --role "$1" --scope "$2" --query '[0].id' -o tsv --only-show-errors)" ]; then
      az role assignment create --assignee "$deploy" --role "$1" --scope "$2" --only-show-errors --output none
      echo "granted  $1"
    else
      echo "kept     $1"
    fi
  }
  # Reading the deployment's outputs; building images; upgrading the chart. Nothing on the vault: the
  # cluster reads secrets, the pipeline never does.
  assign Reader "$rg_id"
  assign Contributor "$registry_id"
  assign "Azure Kubernetes Service RBAC Cluster Admin" "$cluster_id"
  assign "Azure Kubernetes Service Cluster User Role" "$cluster_id"
  ;;

*)
  echo "usage: setup-identity.sh create <public-url> <owner/repo> [<vault>] | grant <resource-group>" >&2
  exit 2
  ;;
esac
