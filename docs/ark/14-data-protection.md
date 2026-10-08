# Data protection (GDPR)

Written 2026-10-08, by engineering, from the code as it stands. It is the record of **what Ark holds,
where, why, for how long, who else sees it, and how a person exercises their rights**. It is not legal
advice: the privacy notice, the data processing agreements and the choice of lawful basis need a
lawyer's review before the first customer. Items only the owner can supply are marked **[owner]**.

## Who is responsible for what

- **Ark is the controller** of the data of the people who sign up: their account, their sign-in, their
  plan, what they tell their coworkers and what the coworkers do for them.
- On **Ark Team** and **Ark Team Enterprise**, a company's staff put the company's information into
  Ark. For that content Ark is the company's **processor**, and the company is the controller. Ark
  therefore needs a **data processing agreement** to offer those customers. **[owner]** (the standard
  clauses are short; the substance is this page.)
- **The legal entity is Black Ark** (named by the owner, 2026-10-08). Still to supply **[owner]**: the
  registration number and legal form, the registered address, the mailbox that answers privacy
  requests, and the country of establishment, which decides which data-protection authority supervises. Whether a Data Protection
  Officer is required depends on scale and should be asked of the lawyer.

## What Ark holds, and where

Everything lives in one PostgreSQL server in **West Europe** (two databases: `openbot`, the
application; `hub`, the conversations). There is no other store of customer data.

| Data | Where | What it is for | Kept |
| --- | --- | --- | --- |
| **Identity**: name, address, picture, when they signed in, how (Google, Microsoft, Okta), session records | `openbot`: `users`, `accounts`, `sessions` | Signing in; telling people apart | While the account exists. Sessions expire. |
| **Role** (administrator or not) | `user_roles` | Deciding who may reach the admin screens | While the account exists |
| **Account and plan**: which plan, status, the payment provider's customer and subscription ids, every billing event | `tenants`, `tenant_memberships`, `subscriptions`, `billing_events` | Selling and enforcing the plan | While the account exists. Not card or bank details: those never reach us. |
| **Cloud running**, if they use Ark's cloud: whether it is on, their monthly limit, the prices they agreed to and when (each set of prices, with the dates it applied); the months charged, with the hours used and the amount; and a record of when each coworker's runs, computer and storage were in use | `cloud_accounts`, `cloud_charges`, `cloud_intervals` | Charging for what they chose to use, at the prices they agreed to; keeping them to their limit; explaining a charge | While the account exists. Included in the data export (without the payment service's reference or our notes). Deleted with the account. Staff's one row of prices (`cloud_rates`) holds no personal data. |
| **Coworkers** (bots) they created: name, instructions, the model they use, which tools they may use | `agent_profiles`, `agents`, `plugin_grants`, `bot_model_choices` | Doing the work | Until the coworker is deleted or the person is erased |
| **Conversations**: everything said to and by a coworker | `hub` database (threads and their event log); the application keeps only an index | Showing the conversation back; the coworker's memory of it | Until deleted or the person is erased |
| **Files** they attached to a conversation | `openbot`: `attachments` (the bytes are in the database) | Giving the coworker the file | Same |
| **Voice**: the transcript and length of a voice session | `voice_sessions` | Showing it back | Same. Audio itself is never stored (the provider's own retention applies). |
| **Their instructions and preferences**, skills and routines | `user_instructions`, `skills`, `routines`, `users.preferences` | Behaving as they asked | Same |
| **Model connections**: which provider and model, and **the key, encrypted** | `model_connections` | Using their own model account | Same. The key is never shown again, never exported and never sent to the browser. |
| **Connected apps** (Gmail and the like): that a connection exists; the vendor holds the token | `composio_connections`, `mcp_user_credentials` (encrypted) | Letting a coworker act in their app | Same. See the integration vendor below. |
| **Marketplace**: a publisher name, and any coworker they chose to share (an inert, secret-stripped snapshot), their installs from Ark's catalogue, and reports they made | `marketplace_publishers`, `marketplace_listings`, `marketplace_installs`, `marketplace_reports` | Sharing, if they chose to | Publisher and listings belong to the **account**: until taken down, or the account is erased. Installs and the link to a report go with the person. |
| **Audit trail**: who did what, when (sign-ins, role changes, billing changes, exports, erasures) | `audit_events` | Security, accountability, dispute | **365 days in the hosted deployment** (`AUDIT_RETENTION_DAYS`), then removed. See "What is kept" below. |
| **Run slots**: which coworker is running now | `run_slots` | Enforcing the plan's limit | Seconds to minutes; removed with the person |
| **Server logs** | Log Analytics | Operating the service | **90 days** in `prod` |
| **Backups** | Azure | Recovery | **35 days** (point-in-time), copied to the paired region |

Nothing here is used for advertising, sold, or used to train a model.

## Who else sees it (sub-processors and other recipients)

| Who | What they receive | Why | Notes |
| --- | --- | --- | --- |
| **Microsoft Azure** (West Europe) | Everything, as the host | Hosting, backups, logs; and **Entra ID** for staff sign-in | Processor. Microsoft's data protection addendum applies to the subscription **[owner: confirm it is in force]**. Backups are geo-copied to the paired region (Europe). |
| **Paddle** | Name, address, country, what was bought, and the payment | Selling the plan, tax and VAT, invoices, refunds | Paddle is the **seller (merchant of record)** and holds payment data under its own terms. It is an independent controller for that. We never see card numbers. |
| **The model provider the person chooses** (Anthropic, OpenAI, Google, xAI or others they connect, or a local model) | The text, files and tool results of the conversation the coworker is having | Producing the answers | The person connects their own account, so the data goes where they instructed. With a local model it goes nowhere. Providers are outside the EU in some cases; the transfer is under that provider's standard contractual clauses **[owner/lawyer]**. If Ark later provides its own managed model access, Ark's agreement with that provider is added here and the notice updated. |
| **Composio** (integration broker) | The connection to the apps the person links, and the calls a coworker makes through them | Letting a coworker use Gmail, Calendar, etc. | Processor. Erasure asks Composio to revoke the connection; if it does not answer, the person is told and staff are told **to follow up** (below). |
| **Google** | That the person signed in | Sign-in with Google | Independent controller for its own sign-in. |
| **A transcription provider**, if the deployment enables dictation | The audio of a dictation | Turning speech into text | Optional; off unless configured **[owner: decide before launch]**. |
| **Let's Encrypt** | The site's domain name | Certificates | No personal data. |

There are **no analytics, advertising or tracking services** in the product. CopilotKit's telemetry
and its hosted service, which the original code called, have been removed and replaced (docs/ark/05).
There is no email provider in the product today; if one is added, add it here first.

## Lawful basis (for the lawyer to confirm)

- Running the service the person signed up for, and charging for it: **contract**.
- Security logging, abuse handling, the audit trail: **legitimate interest** (and a legal duty where
  a regulator or court requires it).
- Tax and accounting records: **legal obligation**, held by Paddle as the seller.
- Anything marketing or non-essential: **consent**, asked separately. None exists today.

## People's rights, and how each is met

Everything marked *self-serve* is done by the person themselves, signed in, at **Settings → Your data**.
The month the law allows to answer starts when we receive the request; the screens answer at once.

| Right | How |
| --- | --- |
| **Access and portability** (Art. 15, 20) | *Self-serve.* **Download your data** gives one JSON file: account, plan, coworkers, instructions, skills, routines, connections (without the keys), conversations, voice transcripts, file names, marketplace items and the audit entries about them. Staff can produce the same for somebody who wrote to us (Admin → People → Export). Every export is on the audit trail. |
| **Erasure** (Art. 17) | *Self-serve.* **Delete my account** (the person types their own address to confirm). Staff can do it for someone who wrote to us (Admin → People → Erase…, typing that person's address). What happens, in this order, so a failure leaves them exactly as they were and the request can simply be repeated: (1) their subscription is stopped at Paddle (if that fails, nothing else happens and they are told why); (2) their conversations are removed from the hub; (3) each connected app is revoked at the vendor; (4) in **one transaction**, their coworkers, files, voice transcripts, skills, routines, instructions, model and app credentials, sessions and sign-in links, marketplace items, and then the person; (5) if they were the only member of a hosted account, the account and its plan go too. |
| **Rectification** (Art. 16) | Their name and details come from the sign-in provider and can be corrected there or by writing to us. Their coworkers and instructions they edit themselves. |
| **Restriction and objection** (Art. 18, 21) | By writing to us. Staff can remove access immediately (Admin → People) without erasing, which holds the data without using it. |
| **Complaint** | To the supervisory authority; stated in the privacy notice. |

**Refusals, on purpose.** An administrator cannot erase their own account from the self-serve screen
(another administrator does it), and the **last** administrator cannot be erased at all: the role has
no way back in. A shared company account's other members are never removed by one member's request.

### What is kept after erasure, and why

1. **The audit trail**, until its retention period ends (365 days). It records that an action happened
   and which account id did it, not the contents of anything. It is append-only by design, because a
   record that can be edited is not evidence. An erasure is itself recorded there (the id, not the
   address). Its retention is the compromise between the duty to be able to show what happened and the
   duty not to keep what is not needed; **the lawyer should confirm 365 days**.
2. **Paddle's records** of the purchase, because tax law makes Paddle keep them. We hold no copy of
   payment details; a person who wants Paddle's records erased or exported asks Paddle.
3. **Backups**, which fall out of the 35-day window by themselves. They are not queried or restored
   except in a disaster, and after a restore every erasure made since the restore point is **done
   again** (docs/ark/13-azure-hosting.md). A person erased today is therefore fully gone from the
   systems within 35 days.
4. **On a shared Team or Enterprise account, what belongs to the account stays.** One member's erasure
   removes that member and everything of theirs (their coworkers, files, conversations, keys,
   sign-ins). It does not remove the account, its plan, or the publisher name and shared listings the
   account owns: those are the company's, and they go when the company's account is erased. Nobody can
   have installed a shared listing (they are view-only), so nothing of anyone else's depends on it.

The erasure result lists anything that could not be done automatically (for example an integration
vendor that did not answer) so staff can chase it. That list goes into the audit entry.

## Security measures (the short version; detail in 15-security-review.md)

- Keys, tokens and passwords are **encrypted at rest** with a key that is not in the database or the
  repository, are write-only in the product and never leave the server (not to the browser, not in an
  export).
- Everything is encrypted in transit: HTTPS to the browser, TLS to the database.
- The database is **not on the internet**. Staff reach the cluster only through Entra ID.
- Customers' data is separated by account inside the application (one rule shared by every place
  that reads it) and tested across two customers. It is **not** separated by row-level rules in the
  database; see the open items in 15-security-review.md.
- Access to production secrets is logged by Key Vault; the pipeline never reads them.
- Staff administrator rights come only from a sign-in that can prove the address is theirs.
- Sharing a coworker publicly refuses secrets and private data before anything is published.

## If something goes wrong: a personal-data breach

Within **72 hours of becoming aware** the supervisory authority must be told, unless the breach is
unlikely to put people at risk; if the risk is high the people affected must be told without undue
delay. So:

1. **Contain**: revoke the access that was used; roll back or take the affected service down; rotate
   every secret that could have been read (13-azure-hosting.md, "Secrets and rotation"; Key Vault's
   access log says what was read).
2. **Record**, in a dated note kept outside the product: what happened, when it was noticed, what
   data and how many people, what was done.
3. **Decide** (owner, with the lawyer) whether the authority and the people must be told, within the
   72 hours. If unsure, report: reporting that proved unnecessary costs little.
4. **Tell**: the authority through its online form; the people affected in plain words (what, what it
   means for them, what to do, who to contact). Customers on Team plans are told too, since they are
   the controller of their staff's content (the DPA sets the time).
5. **Learn**: fix the cause and add a test or a check.

## The legal drafts

Written from this page, for a lawyer to review: [the privacy notice](../legal/privacy-notice.md) (shown in
the app at `/privacy`, which is also the address Google's sign-in consent screen asks for) and a
[data processing agreement template](../legal/data-processing-agreement.md) for Team and Enterprise
customers. There are no terms of service yet; the plan terms the agreement refers to are still to be written.

**Statements in those drafts that must be true on the day they are published.** Each is a promise to
customers, so check each one rather than assume it:

- [ ] Staff sign in with multi-factor authentication (an Entra conditional-access policy; security
      review O9).
- [ ] The audit trail is kept 365 days (`AUDIT_RETENTION_DAYS`, set in `values-azure.yaml`).
- [ ] Server logs are kept 90 days and backups 35 days (the `prod` sizing).
- [ ] A restore has been rehearsed (13-azure-hosting.md).
- [ ] Composio's location and terms are known and a data processing agreement is in place.
- [ ] The Azure contracting entity named in the sub-processor table matches the agreement.
- [ ] If the breach-notice time in the agreement template is changed from 48 hours, the breach
      procedure above agrees with it.

## Before the first customer

- [ ] Privacy notice and data processing agreement reviewed by a lawyer; their [bracketed] items filled in.
- [ ] Microsoft's data protection addendum, Paddle's terms, Composio's DPA and each default model
      provider's DPA in place; standard contractual clauses for any transfer outside the EEA.
- [ ] A named person and mailbox who answers privacy requests within the month.
- [ ] Audit retention (365 days) confirmed.
- [ ] A rehearsal: sign up a test account, fill it, export it, erase it, and check with the checklist
      above that nothing is left, in a `dev` deployment with the real hub and Paddle's sandbox.
      (The automated tests do this against a database with fakes for the hub and the payment service;
      the rehearsal is the real thing.)
- [ ] The Composio and Paddle steps of erasure rehearsed against the real services, since only fakes
      stood in for them in testing.
