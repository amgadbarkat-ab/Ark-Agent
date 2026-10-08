# Ark on Azure

Infrastructure as code for hosting Ark on Microsoft Azure, with sign-in by Microsoft Entra ID. The
reasoning, the day-to-day operation and what is and is not verified are in
[docs/ark/13-azure-hosting.md](../../docs/ark/13-azure-hosting.md). This page is the order of the commands.

## What it creates

| Piece | What | Why |
| --- | --- | --- |
| `modules/network.bicep` | A virtual network, a subnet for the cluster and one only the database may live in, and a private DNS zone | The database has no public address |
| `modules/database.bicep` | PostgreSQL Flexible Server 16 with two databases (`openbot`, `hub`), 7 to 35 days of point-in-time backups, optional zone-redundant standby and geo-redundant copy | Backups, patching and failover are Azure's |
| `modules/cluster.bicep` | AKS: Entra-only sign-in (no static kubeconfig), workload identity, network policy enforced, three zones in `prod`, a system pool and an autoscaling work pool, the managed NGINX ingress, control-plane audit logs | The Helm chart's home |
| `modules/registry.bicep` | Container registry, no admin user; the cluster pulls with its own identity | Where the images live |
| `modules/keyvault.bicep` | Key Vault with role-based access, soft delete, purge protection and an audit log | Where every secret lives |
| `modules/identity.bicep` | An identity the External Secrets operator uses to read the vault, trusted by the cluster's token, with read-only access | The cluster reads secrets without holding a password |
| `modules/monitoring.bicep` | Log Analytics, Application Insights, an alert mailing list | One place for logs and for being told |
| `modules/alerts.bicep` | Alerts (database busy, filling up, refusing connections; nodes hot; the site down from two of three places) and a monthly budget | What wakes somebody; what stops a surprise bill |

`main.dev.bicepparam` and `main.prod.bicepparam` choose sizes. Both compile with no warnings
(`bicep build`), which also type-checks every property against Azure's published schema.

## Before the first command

1. **An Azure subscription** and the Azure CLI, signed in (`az login`) as an owner while setting up.
2. **An Entra group** for the people who administer the cluster. Its object id is `adminGroupObjectId`.
3. **Staff sign-in.** In Ark's own Entra directory, register an application (single tenant, web
   redirect `https://<your address>/api/auth/callback/microsoft`) and note its client id and the
   directory's id. The directory id must be a GUID: `common` would let anybody with any directory
   claim a staff address (docs/ark/15-security-review.md).
4. **Customer sign-in.** A Google OAuth client for `https://<your address>/api/auth/callback/google`.
5. **Paddle**, set up in its sandbox first (docs/ark/12-paddle.md).
6. **Two DNS names** under your domain, one for the application and one for the hub
   (for example `ark.example.com`, `hub.ark.example.com`).
7. **A mailbox somebody reads**, for alerts and for Let's Encrypt.

Replace the `REPLACE` and example values in `main.<env>.bicepparam` and `values-azure.yaml`.

## The commands

```sh
# 1. The place. Western Europe by default: the customers are in the EU and their data stays there.
az group create -n rg-ark-prod -l westeurope

# 2. The infrastructure. The database administrator's password is made here, used by the deployment,
#    and stored in the vault in step 3. It is not written anywhere else.
export ARK_POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
az deployment group create -g rg-ark-prod -n main -f main.bicep -p main.prod.bicepparam

# 3. The secrets. Needs "Key Vault Secrets Officer" on the vault (grant yourself, once).
vault=$(az deployment group show -g rg-ark-prod -n main --query properties.outputs.keyVaultName.value -o tsv)
db=$(az deployment group show -g rg-ark-prod -n main --query properties.outputs.databaseHost.value -o tsv)
scripts/bootstrap-secrets.sh "$vault" "$db"      # creates what can be generated; lists what a person must set
unset ARK_POSTGRES_ADMIN_PASSWORD
az keyvault secret set --vault-name "$vault" --name ark-google-client-secret    --value '<from Google>'
az keyvault secret set --vault-name "$vault" --name ark-microsoft-client-secret --value '<from Entra>'
az keyvault secret set --vault-name "$vault" --name ark-paddle-api-key          --value '<pdl_live_apikey_...>'
az keyvault secret set --vault-name "$vault" --name ark-paddle-webhook-secret   --value '<pdl_ntfset_...>'

# 4. The cluster, as yourself (Entra sign-in; the group above gives you cluster-admin).
az aks get-credentials -g rg-ark-prod -n "$(az deployment group show -g rg-ark-prod -n main --query properties.outputs.clusterName.value -o tsv)"
kubelogin convert-kubeconfig -l azurecli

# 5. What the chart expects to find in the cluster.
client_id=$(az deployment group show -g rg-ark-prod -n main --query properties.outputs.secretsIdentityClientId.value -o tsv)
helm repo add external-secrets https://charts.external-secrets.io && helm repo add jetstack https://charts.jetstack.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace \
  -f k8s/external-secrets-values.yaml \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"="$client_id"
KEY_VAULT_URI=$(az deployment group show -g rg-ark-prod -n main --query properties.outputs.keyVaultUri.value -o tsv) \
  envsubst < k8s/cluster-secret-store.yaml | kubectl apply -f -
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f k8s/cluster-issuer.yaml

# 6. Point the two DNS names at the ingress.
kubectl get svc -n app-routing-system nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

# 7. Let the pipeline deploy. Create an app registration for GitHub, trust the repository's `prod`
#    environment, and give it the least it needs (see the table below), then run the workflow
#    "Deploy Ark to Azure" from the Actions tab. The first run builds both images and installs the chart.
```

### What the pipeline's identity may do

| Where | Role | For |
| --- | --- | --- |
| The resource group | Reader | reading the deployment's outputs |
| The registry | Contributor | `az acr build` |
| The cluster | Azure Kubernetes Service RBAC Cluster Admin (or membership of the admin group) | `helm upgrade` |

It has no access to the vault: the cluster reads secrets, the pipeline never does.

```sh
az ad app create --display-name ark-deploy
az ad sp create --id <appId>
az ad app federated-credential create --id <appId> --parameters '{
  "name": "ark-prod", "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:environment:prod", "audiences": ["api://AzureADTokenExchange"]}'
```

Then set the repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and
`AZURE_RESOURCE_GROUP`, and give the `prod` environment required reviewers.

## After the first deploy

Walk the checklist in docs/ark/13-azure-hosting.md ("Before customers"): a sign-in, a purchase in
Paddle's sandbox, a restore of the database into a scratch server, and a look at each alert.
