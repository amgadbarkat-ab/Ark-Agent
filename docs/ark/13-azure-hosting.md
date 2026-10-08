# Ark on Azure: architecture and runbook

Written 2026-10-08. Hosting target confirmed by the owner the same day: **Microsoft Azure**, with
**Microsoft Entra ID** for staff sign-in. The commands, in order, are in
[infra/azure/README.md](../../infra/azure/README.md); this page is the reasoning and what to do when
something happens.

**Read the last section first** ("What has and has not been checked"). Everything below was written
and compiled without an Azure subscription to try it on.

## Why this shape

| Choice | Reason |
| --- | --- |
| **AKS** (Kubernetes) rather than a container-app service | The repository already ships a Helm chart that runs the application, the conversation hub, the scheduled routines and the bot computers. Using it unchanged means there is one way to deploy, and the same chart serves a customer who runs Ark on their own cluster later. |
| **PostgreSQL Flexible Server**, private only | Backups, patching, failover and point-in-time recovery are Azure's job, not ours. It has no public address: the only thing that can reach it is the cluster's network. |
| **Key Vault + External Secrets** | Every secret lives in one place that keeps an access log, has soft delete and purge protection, and is read by the cluster with its own identity. No secret is in the repository, in a values file, or in the pipeline. |
| **Workload identity** | The cluster proves who it is with a short-lived token. There is no client secret to leak or to expire on a Sunday. |
| **Entra-only cluster sign-in** | No static kubeconfig exists. Administering the cluster needs a person signed in to Entra, in the admin group, which also gets MFA and conditional access for free. |
| **`az acr build`** in the pipeline | Images are built in Azure's registry. Nothing is pushed from a runner, so no registry password exists. |
| **West Europe** | Customers are in the EU and their data stays there. |

## The picture

```
 customers / staff
        │  HTTPS (cert-manager, Let's Encrypt)
        ▼
 managed NGINX ingress ──────────────┐
        │                            │ wss (live conversations)
        ▼                            ▼
 ark  (API + web app, ≥2 replicas)   ark-hub  (conversation service)
        │   │   │                         │
        │   │   └── bot computers ◄───────┘  (one per active bot, in the cluster)
        │   │
        │   └── scheduled routines (a CronJob calling the API)
        ▼
 PostgreSQL Flexible Server (private) ── databases: openbot, hub
        │
        └── backups: 35 days point-in-time, copied to the paired region (prod)

 Key Vault ──► External Secrets ──► the cluster's Secret "ark-secrets"
 ACR (images)      Log Analytics + Application Insights ──► alerts ──► the ops mailbox
```

Staff (Ark's own people) sign in with **Microsoft Entra ID**, single-directory. Customers sign in with
**Google** today; other providers can be added without a code change. Only a sign-in that can vouch
for the address (Google with a verified address, Okta, a single-directory Microsoft application, or a
registered SSO provider) can ever produce an administrator. Why, and the attack this closes, is in
[15-security-review.md](15-security-review.md).

## Two sizes

| | `dev` | `prod` |
| --- | --- | --- |
| Database | Burstable `B2s`, 32 GB, 7 days of backups, one zone | General Purpose `D2ds_v5`, 128 GB, **35 days**, **zone-redundant standby**, **geo-redundant backups** |
| Cluster | one zone, system pool + work pool of 1 to 2 `D2s_v5` | three zones, system pool + work pool of 2 to 6 `D4s_v5`, autoscaling |
| Registry | Basic | Standard |
| Logs kept | 30 days | 90 days |
| API replicas | the chart's default | 2 (`server.replicaCount` in `values-azure.yaml`) |

Both compile with zero warnings (`bicep build`). Costs are not estimated here: they depend on the
region and the agreement, and the **monthly budget** in the template (`monthlyBudget`) mails the ops
list at 80% spent and when the forecast says the month will pass the whole amount. Set it before the
first deploy.

## Day to day

### Deploy

Actions → **Deploy Ark to Azure** → choose `dev` or `prod`. For `prod` the run waits for a reviewer
(the `prod` environment must have required reviewers; set that up once). It builds both images,
upgrades the chart with `--atomic --wait` and then calls `/health`. A release that does not come up
healthy is rolled back by Helm itself and the run fails.

Every image is tagged with the commit that built it, so "what is running" is
`helm get values ark -n ark | grep tag`.

### Roll back

```sh
helm history ark -n ark          # find the last good revision
helm rollback ark <revision> -n ark --wait
```

Database migrations only ever add. A rollback of the code does not undo a migration, and the previous
version works against the newer schema. If a migration itself was wrong, that is a restore (below),
not a rollback.

### Look at it

- **Is it up?** The availability test in Application Insights calls `/health` from three places; the
  alert fires when two of three fail.
- **Logs.** Log Analytics holds the cluster's and the database's logs. The API writes one line per event.
- **Who did what.** Admin → Audit in the product itself, and Key Vault's own access log for secrets.

### Scale

- More traffic: raise `workMax` for the work pool, or `server.replicaCount` in `values-azure.yaml`.
  The autoscaler adds nodes by itself up to `workMax`; the **node CPU** alert tells you when it is at
  the ceiling.
- Database busy: the **database CPU** alert says so. Look at slow queries first; scaling the server
  up is a change of `databaseSku` and a redeploy of the template, and takes a short outage unless the
  standby is on (it is, in `prod`).
- Database filling: storage grows by itself; the alert at 85% is a prompt to find out why.

## Backups and the restore drill

Azure takes the backups; **a backup nobody has restored is a hope.** Do this before the first
customer, then every quarter, and write the date at the bottom of this page.

1. **Pick a time** a few minutes ago and a scratch name:
   ```sh
   az postgres flexible-server restore -g rg-ark-prod \
     -n ark-prod-restore-test --source-server <server name> \
     --restore-time "2026-10-08T09:00:00Z" \
     --subnet <the database subnet id> --private-dns-zone <the private zone id>
   ```
   A server with private access must be restored into a subnet and private zone of its own choosing;
   the ids are in the resource group.
2. **Connect from inside the cluster** (a throwaway pod with `psql`) and check the numbers:
   people, agents, the latest `audit_events` row, and the `hub` database's thread count.
3. **Check that migrations are consistent:** `select max(id) from drizzle.__drizzle_migrations`
   matches the running release.
4. **Delete the scratch server.** It costs money and holds customer data.
5. **Time it.** Write down how long step 1 took. That is the real answer to "how long are we down
   if the database is lost".

**Regional disaster.** `az postgres flexible-server geo-restore --source-server ... --location
northeurope` brings the copy up in the paired region; the cluster and vault would have to be built
there too (the template can do it with another resource group). This is slower and has not been
rehearsed: decide with the owner whether that risk is acceptable before launch.

**Data is also in the hub's database.** Both databases are on the one server and are restored
together. Restoring only one would leave conversations pointing at a different set of coworkers than
the application knows.

### After a restore: erased people come back

A restore returns the database to a past moment, including people who had not yet asked to be erased
and, worse, people who **had**. Erasing someone and then bringing them back is a breach of the promise
we made them, so after any restore, erase again whoever was erased since the restore point.

- **If the old database can still be read** (a planned restore, a bad migration): before restoring,
  save `select target_id, created_at from audit_events where event_type = 'person.erased'`, and run the
  erasures again afterwards from Admin → People.
- **If it cannot** (the database is lost): the list is not in the database any more. Rebuild it from
  the support mailbox and from the cancellations Paddle recorded in the same period, and record that
  this was done in the incident note.

Either way write it into the incident record. (14-data-protection.md explains the duty.)

## Secrets and rotation

All secrets are in Key Vault. The cluster reads them through External Secrets, which refreshes on a
schedule; **pods read their environment at start**, so a rotation takes effect on the next rollout:

```sh
kubectl rollout restart deployment -n ark
```

| Secret | What rotating it does | How |
| --- | --- | --- |
| `ark-key-encryption-key` | It seals every stored credential, model key and directory secret. **Never just replace it**: the values it sealed become unreadable. Rotate it with the procedure below, which re-seals everything under the new key with no downtime and nothing lost. | "Rotating the data encryption key", below. |
| `ark-better-auth-secret` | Signs everybody out. Harmless. | Set a new value, restart. |
| `ark-hub-api-key`, `ark-hub-join-secret` | Live conversations drop and reconnect. Both services must pick up the new value together. | Set both, `rollout restart` the API and the hub in the same minute. |
| `ark-computer-token`, `ark-worker-shared-secret` | Bot computers and the routines job use these. | Set, restart everything. |
| `ark-postgres-admin-password` and the two database URLs | The connection string changes. | Change the password on the server (`az postgres flexible-server update --admin-password`), set the new password and both URLs in the vault, restart. |
| `ark-google-client-secret`, `ark-microsoft-client-secret` | Sign-in with that provider stops working until the new value is in. | Create a second secret in the provider's console, set it in the vault, restart, then delete the old one. Microsoft secrets expire: **put the expiry date in the calendar.** |
| `ark-paddle-api-key`, `ark-paddle-webhook-secret` | Billing stops (API key) or webhooks are refused (secret). | Paddle accepts two webhook signatures during rotation; add the new secret, restart, remove the old. |

`bootstrap-secrets.sh` never overwrites anything that exists. Re-running it is safe; it is not a
rotation.

If a secret may have leaked: rotate it first, then work out the how. Key Vault's access log says who
read what and when.

## Rotating the data encryption key

When: on a schedule the customers' questionnaires ask for, or at once if the key may have leaked.
Takes about ten minutes, with no downtime. **Values already stored keep working throughout**, and
nothing new is ever sealed under the old key once the new one is in.

How it works: each sealed value carries a short fingerprint of the key that sealed it. The server holds
the new key (`KEY_ENCRYPTION_KEY`), which seals everything new, and the old one
(`KEY_ENCRYPTION_KEY_PREVIOUS`), which is only ever used to read. A script re-seals every stored value
under the new key; when it reports nothing is left under the old one, the old one is removed.

1. **Make the new key** and keep the old one:
   ```sh
   old=$(az keyvault secret show --vault-name "$vault" --name ark-key-encryption-key --query value -o tsv)
   az keyvault secret set --vault-name "$vault" --name ark-key-encryption-key-previous --value "$old" >/dev/null
   az keyvault secret set --vault-name "$vault" --name ark-key-encryption-key \
     --value "$(openssl rand -base64 32)" >/dev/null
   unset old
   ```
   The old key is copied *first*, so there is no moment at which neither exists.
2. **Tell the cluster to read the old key.** In `infra/azure/values-azure.yaml`, add this to
   `externalSecrets.data` (the environment variable is already wired, as optional):
   ```yaml
   - secretKey: key-encryption-key-previous
     remoteRef: { key: ark-key-encryption-key-previous }
   ```
   Run the deploy workflow. The pods restart holding both keys.
3. **See what will change** (changes nothing; exit code 2 means work remains):
   ```sh
   kubectl exec -n ark deploy/<the server deployment> -- sh -c 'cd /app/server && bun scripts/rotate-encryption-key.ts'
   ```
   The output is counts and row ids, never a value.
4. **Re-seal**, then check it:
   ```sh
   kubectl exec -n ark deploy/<the server deployment> -- sh -c 'cd /app/server && bun scripts/rotate-encryption-key.ts --apply'
   kubectl exec -n ark deploy/<the server deployment> -- sh -c 'cd /app/server && bun scripts/rotate-encryption-key.ts'
   ```
   It is safe to run while people use the product, and to run twice: a row somebody changed in the
   meantime is left for the next pass instead of being overwritten with the old value.
5. **Prove the old key is no longer needed.** Run it once more with the old key *removed from the
   process*, which is exactly the state the server will be in afterwards:
   ```sh
   kubectl exec -n ark deploy/<the server deployment> -- sh -c 'cd /app/server && env -u KEY_ENCRYPTION_KEY_PREVIOUS bun scripts/rotate-encryption-key.ts'
   ```
   **Exit 0 is the only answer that allows the next step.** Exit 1 lists rows no key it holds can open:
   keep the old key, and find out why before going on (a value sealed under a third, older key that
   was never kept is the usual reason, and is unrecoverable by anyone).
6. **Retire the old key.** Remove the entry added in step 2, deploy, then disable the vault secret
   (`az keyvault secret set-attributes --enabled false`) and, after a week with nothing wrong, delete it.
   Keep a note of the date.

If a step fails, nothing is lost: the old key is still in the vault and the server reads with it.

## When something is wrong

| Sign | First look | Likely cause |
| --- | --- | --- |
| Site down alert | `kubectl get pods -n ark`, then `kubectl logs deploy/ark -n ark` | A bad release (roll back), the database unreachable, or the certificate. |
| Database connections failing | Alert text; the vault's `ark-database-url` | A password changed on one side, or the network policy was edited. |
| Nobody can sign in | `/api/auth/*` errors in logs; the provider's console | An expired client secret (Microsoft especially) or a wrong redirect address. |
| Customers pay and nothing changes | Admin → Accounts, the account's billing events; Paddle's notification log | The webhook secret is wrong, or the address changed. Events are idempotent and ordered, so replaying from Paddle's dashboard is safe. |
| Replies stop arriving | `kubectl logs deploy/ark-hub -n ark` | The hub cannot reach its database, or the join secret differs between the API and the hub. |
| Cost alert | Cost analysis by resource | A runaway work pool, logs, or a forgotten scratch server. |

**A suspected breach** is handled by the procedure in
[14-data-protection.md](14-data-protection.md): contain, rotate, record, and decide within 72 hours
whether the regulator and the people affected must be told.

## Before customers

Tick each one with the date and who did it. Nothing here is optional.

- [ ] `az deployment group create` succeeds for `prod`; no manual changes afterwards.
- [ ] Entra app registration for staff is **single-directory** (the directory id in the
      configuration is a GUID, never `common`), and an administrator signs in through it.
- [ ] Customer sign-in with Google works from a fresh account; that account is **not** an administrator.
- [ ] The **restore drill** above, with the time it took.
- [ ] Each alert fired once on purpose (stop the pods, fill a scratch table, etc.) and reached the mailbox.
- [ ] A **dependency scan and an image scan** run (see the security review) and nothing critical is open.
- [ ] `helm rollback` rehearsed on `dev`.
- [ ] The `prod` GitHub environment has required reviewers; nobody can deploy by themselves.
- [ ] Privacy notice and the processor list in [14-data-protection.md](14-data-protection.md) are
      published, and the data processing agreements with Microsoft, Paddle, the model providers and
      Composio are signed or accepted.
- [ ] A **penetration test** by someone who is not us, or the owner has accepted in writing going live
      without one.
- [ ] DNS for the two names points at the ingress; HSTS is on (it is, once the address is `https://`).
- [ ] **LAST: the Paddle sandbox run**, by the owner, once everything above is done and the sandbox
      is wired to the real `dev` deployment: a purchase end to end, following the checklist in
      [12-paddle.md](12-paddle.md) (checkout, webhook, plan change, cancel, a replayed webhook). Only
      then: the Paddle live keys go in the vault, `PADDLE_ENVIRONMENT=production`, and the `live_` /
      `pri_` placeholders in `values-azure.yaml` are replaced. Until it does, the payment adapter is proven against a fake
      Paddle only.

## What has and has not been checked

**Checked, here, by running it:**
- `bicep build` of the whole template for both sizes: zero warnings, and every property is
  type-checked against Azure's published schema.
- The Helm chart renders with the Azure values, and a coherence check (`scripts/check-rendered-chart.ts`)
  finds what it expects: both services, the hub's policy, the secret references.
- `bootstrap-secrets.sh` against a fake vault: creates, keeps, never prints a secret.
- The hub starts from a tree shaped like its image, serves `/health` and migrates.
- All the product behaviour that deploys (billing, erasure, export, marketplace) by automated tests
  and, for the screens, in a real browser.

**Not checked, because it needs things this environment does not have:**
- **A real deployment to Azure.** No subscription was available. The template is correct by the
  schema; whether quotas, policies or names in a specific subscription allow it is only learnt by
  running it. Expect to fix small things on the first `dev` deployment.
- **The two Docker images.** Docker Hub's rate limit blocked builds in the sandbox. The Dockerfiles
  were corrected for the hub workspace (`hub/package.json` is copied), but the first `az acr build`
  is the first real build.
- **`helm dependency build`** for the chart (its database sub-chart comes from a registry that was
  also rate-limited here). The pipeline runs it.
- **The restore drill and the alerts.** Written, not exercised.
- **Paddle against the real service.** Only against a fake that follows Paddle's documentation.

## Restore drills

| Date | By | Time to restore | Notes |
| --- | --- | --- | --- |
| *none yet* | | | |
