# Data Processing Agreement (template)

> **DRAFT TEMPLATE for review by a lawyer.** For customers on Ark Team and Ark Team Enterprise, whose
> staff put the customer's own information into Ark. It follows GDPR Article 28. Items in [square
> brackets] are for Black Ark or the customer to fill in. It is meant to be attached to the main
> agreement (the plan terms), which governs liability and everything not covered here.

**Between** [Customer legal name and address] (the **Controller**) **and Black Ark**, [legal form,
registration number and registered address] (the **Processor**).

## 1. What this covers

1.1 The Processor provides the Ark service to the Controller (digital employees that work for the
Controller's staff). In doing so the Processor processes personal data on the Controller's behalf. This
agreement governs that processing.

1.2 Details of the processing are in **Annex I**. The security measures are in **Annex II**. The
sub-processors are in **Annex III**.

## 2. The Processor's duties

The Processor will:

a. process the personal data **only on the Controller's documented instructions**, which are this
   agreement, the plan terms, and the Controller's use of the service's features; and tell the
   Controller at once if it thinks an instruction breaks data-protection law;

b. make sure everyone who may access the data is **bound to confidentiality**;

c. apply the **security measures** in Annex II;

d. use only the **sub-processors** in Annex III, and follow clause 4;

e. **assist the Controller** with requests from people exercising their rights. The service lets the
   Controller's people export and delete their data themselves (Settings → Your data) and lets the
   Controller's administrators do so for them. If a person writes to the Processor directly, the
   Processor will pass the request to the Controller and not answer it itself unless told to;

f. **assist the Controller** with its duties on security, breach notification, impact assessments and
   consulting the authority, taking into account the nature of the processing and the information the
   Processor has;

g. **tell the Controller of a personal-data breach without undue delay and in any case within [48]
   hours** of becoming aware of it, with what is known: what happened, what data and how many people,
   the likely consequences, and what is being done;

h. at the end of the service, **delete** the Controller's personal data (or return it, if asked, as a
   file the Controller can read) within [30] days of the Controller's request or the end of the
   agreement, and delete the copies in backups within [35] days after that as they expire, unless the
   law requires it to be kept;

i. make available the information needed to show it complies with this agreement, and **allow audits**
   by the Controller or an auditor it appoints, [no more than once a year, on [30] days' notice, during
   working hours, at the Controller's cost, under confidentiality, and without access to other
   customers' data]. Current independent security reports, if any, are provided in place of an audit
   where they answer the question.

## 3. The Controller's duties

The Controller confirms it has a lawful basis for the personal data it puts into the service, has told
the people concerned, and will not put into the service data the plan terms exclude. The Controller is
responsible for the model provider accounts its staff connect: data a coworker sends to a model
provider the Controller's staff chose is sent on the Controller's instruction, under that provider's
terms, and that provider is **not** a sub-processor of the Processor.

## 4. Sub-processors

4.1 The Controller gives **general authorisation** to the sub-processors in Annex III.

4.2 The Processor will give the Controller at least [30] days' notice of a new sub-processor or a
replacement, by [email to the Controller's contact / a notice in the service]. The Controller may object
on reasonable data-protection grounds within that time. If the parties cannot resolve it, the Controller
may end the affected service and receive a refund of fees for the remaining period.

4.3 The Processor imposes on each sub-processor obligations equivalent to this agreement and stays
responsible to the Controller for them.

## 5. Transfers outside the EEA

The Processor hosts in Western Europe. Where a sub-processor transfers personal data outside the EEA, it
does so under the European Commission's standard contractual clauses, or another valid transfer
mechanism, and the Processor will provide a copy on request. [Lawyer to confirm for each Annex III
entry.]

## 6. Duration

This agreement lasts as long as the Processor processes personal data for the Controller. Clause 2(h)
and clauses on confidentiality and liability survive it.

## 7. General

7.1 If this agreement conflicts with the plan terms about personal data, this agreement prevails.
7.2 Governing law and courts: [as in the plan terms].

---

## Annex I: Details of the processing

| | |
| --- | --- |
| **Subject matter** | Providing the Ark service |
| **Nature and purpose** | Storing and running the Controller's digital employees; holding conversations, files, skills, routines and settings; passing content to the model providers and connected apps the Controller's staff choose; billing support |
| **Duration** | While the Controller uses the service, then as in clause 2(h) |
| **Types of personal data** | Name, work email address, profile picture; the content of conversations, files, instructions and transcripts that staff put in (which may include any personal data the Controller chooses to put in); records of actions (account id, action, time) |
| **Special categories** | None are intended. The Controller decides what its staff put in and must not put in special-category data unless the plan terms allow it. |
| **Categories of people** | The Controller's staff and others whose data the staff put into Ark |
| **Controller's contact** | [name, email] |
| **Processor's contact** | [privacy contact email] |

## Annex II: Technical and organisational measures

These describe what is in place at the date of this agreement. Detail: docs/ark/13, 14 and 15.

- **Location and separation.** Hosted by Microsoft Azure in Western Europe. Customers' data is separated
  by account in the application and tested across two customers. The database has no public address.
- **Encryption.** In transit (TLS to the service and to the database). At rest (Azure storage
  encryption), and in addition keys, tokens and directory secrets are encrypted by the application with
  a key held in Azure Key Vault, rotatable without downtime. These are never shown again, never exported,
  and never sent to the browser.
- **Access control.** Staff sign in through the company's directory with multi-factor authentication.
  Administrator rights are given only to a person whose sign-in can prove their address. The cluster has
  no static credentials; the deployment pipeline holds no password and cannot read secrets.
- **Logging.** An append-only record of security-relevant actions (kept 365 days); Key Vault and cluster
  logs (kept 90 days).
- **Resilience.** Zone-redundant database with a standby, backups kept 35 days with point-in-time
  restore and a copy in the paired region, a restore procedure tested before launch.
- **Vulnerability management.** Dependencies audited and patched; browser protections on every response;
  [independent security test: result and date].
- **People's rights.** Self-service export and deletion for every user, in order so that a failure
  leaves the person's data intact and the request repeatable.
- **Incident response.** A written breach procedure with a 72-hour decision clock.
- **Personnel.** Confidentiality undertakings; access limited to those who need it.

## Annex III: Sub-processors

| Sub-processor | What it does | Where |
| --- | --- | --- |
| Microsoft Ireland Operations Ltd (Azure) [confirm the contracting entity on the Azure agreement] | Hosting, storage, backups, logs | Western Europe; backups also in the paired European region |
| Composio | Connecting the Controller's staff to the apps they link | [location; to confirm] |
| [Any managed model access Black Ark provides: provider, purpose, location] | [Only if Black Ark supplies model access in the plan] | [location] |

Not sub-processors: **Paddle** (the seller of the plan, an independent controller of payment data), and
the **model providers and apps that the Controller's staff connect** themselves.
