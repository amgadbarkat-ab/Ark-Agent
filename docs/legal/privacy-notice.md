# Privacy notice

> **DRAFT for review by a lawyer before publication.** Written by engineering from what the product
> actually does (docs/ark/14-data-protection.md). Items in [square brackets] are for Value Data IKE to fill
> in; nothing else here should need inventing. The app shows this text at `/privacy`.

**Last updated:** [date of publication]

## Who we are

Ark is run by **Value Data IKE**, a private company (ΙΚΕ) registered in Greece that trades as **BlackArk**
("we", "us", "Ark"), [registration number in the Greek commercial registry (ΓΕΜΗ)], of [registered address]. For the personal data described here, Value Data IKE is the **controller**, except where a company
has bought Ark for its staff: for what those staff put into Ark, the company is the controller and Black
Ark acts for it as a processor (see "If your employer or organisation uses Ark").

Questions and requests about your data: **[privacy contact email]**. [If a Data Protection Officer is
appointed: name and contact.]

## What Ark is

Ark gives you digital employees: AI coworkers that do work for you, such as reading and writing, using
your apps, and running tasks on a schedule. To do that, we hold what you tell them and what they do.

## What we collect, why, and on what basis

| What | Why | Basis (GDPR Art. 6) |
| --- | --- | --- |
| **Your sign-in details**: your name, email address and profile picture from the account you sign in with (Google, or Microsoft for our staff); when you signed in; your session | To let you in and tell people apart | Contract: providing Ark to you |
| **Your acceptance of our terms of service**: which version you accepted, and when | To be able to show what you agreed to | Legitimate interests (being able to show what was agreed), and contract |
| **Your plan and billing status**: which plan you have, whether it is active, and the identifiers Paddle gives your subscription | To provide and limit the service you bought | Contract |
| **Cloud running**, if you choose to run your digital employees on our computers: that you switched it on, your monthly limit, the prices you agreed to and when, the months we charged and what for, and a record of when your digital employees ran | To charge you for what you chose to use, at the prices you agreed to, and to keep you to your limit | Contract |
| **What you create**: your coworkers (names, instructions, settings), skills, routines, preferences | To make Ark behave as you asked | Contract |
| **Your conversations and files**: what you say to a coworker, what it answers, tool results, and files you attach | To show them back to you and for the coworker to continue the work | Contract |
| **Voice**: a transcript and length of a voice session you start | To show it back to you. We do not keep the audio. | Contract |
| **Connections you set up**: that you linked an app (such as Gmail), and the keys for model providers you connect, which we store encrypted and never show again | To let your coworkers act for you | Contract |
| **Marketplace**: a publisher name, and any coworker you choose to share (stripped of secrets) | Only if you choose to share | Contract / your choice |
| **A record of actions**: who did what and when (sign-ins, role changes, billing changes, exports, deletions). It records that something happened, not what it contained. | Security, preventing abuse, being able to show what happened | Legitimate interests (keeping the service safe) |
| **Server logs** | Running and securing the service | Legitimate interests |
| **The desktop app's daily check-in**, on a computer with a BlackArk trial or licence: the customer id BlackArk gave you, a random id for that computer, the app version, the trial's state and days left, and, from version 0.1.49, **counts only**: how many people have an account on that computer, how many of them used it in the last 7 days, how many conversations were started in the last 7 days, whether a phone line is set up, and whether it runs Windows, macOS or Linux. Never a name, an email address, a conversation or anything anyone wrote. | To know that a trial or licence is in use, to see an install that stopped working, and to plan support | Legitimate interests (running the trial and the service you bought), and contract |
| **Help & support requests**, only when you send one from the app: what you write, whether it stops your work, your language, the customer id, the computer's random id, the app version, and BlackArk's own signed trial file or licence key that proves the request comes from your computer. If you tick "Include diagnostics", also the system (for example "Windows 10") and the computer's recent warnings and errors, with names, email and web addresses, numbers, ids and keys removed. You see all of it before it is sent. Never your conversations, mail, files or keys. **Before the computer is activated** (no trial or licence yet), there is no signed file to send: the request says it is unverified, and you may add an email address for the answer. To limit such requests to 3 a day, the check-in service keeps, for 24 hours, a scrambled form of the internet address the request came from (a keyed hash, not the address itself). | To answer your request, within our support hours; to stop the unverified requests from being abused | Contract (support for the service you use) |
| **Ark Private Server**, only if you order one from the app: which server you ordered, when you paid and until when, its status, and the address, model name and key BlackArk gives your server. Your payment is taken by Stripe; we never see your card number. | To set up and run the server you ordered, and to connect your app to it | Contract |
| **Email to support@blackark.uk**: the message, its sender and the other addresses on it | To answer it as a support request | Contract, or legitimate interests (answering people who write to us) |

We do not collect more than this, we do not sell your data, we do not use it for advertising, and **we
do not use your conversations or files to train AI models**.

## Who receives it

| Who | What | Why |
| --- | --- | --- |
| **Microsoft Azure** (data centres in Western Europe) | Everything, as our hosting provider | Running Ark, backups, logs |
| **Paddle** | Your name, address, country and what you buy | Paddle is the seller of your plan: it takes payment, collects tax and sends invoices, under its own privacy notice. We never see your card number. |
| **The AI model provider you choose** (for example Anthropic, OpenAI or Google, or a model running on your own computer) | The text and files of the conversation your coworker is having | To produce the answers. You connect your own account with that provider, so the data goes where you told it to, under that provider's terms. With a model on your own computer, it goes nowhere. |
| **Composio** | The connection to the apps you link, and the calls your coworker makes through them | To let a coworker use your apps |
| **Contabo** (Small, Medium and Large) and **Hetzner** (GPU Entry and GPU High), servers in Germany, only if you order an Ark Private Server | What your digital employees send to the model on your private server: the text and files of their conversations | To run the model on the server you ordered, under their EU data processing terms (GDPR data processing agreements) |
| **Stripe** | Your name, email address, country and card, when you buy an Ark Private Server | Stripe takes the payment and sends invoices, under its own privacy notice. We never see your card number. |
| **Google** | That you signed in | Sign-in with Google, under Google's own notice |
| **BlackArk's own support systems**: the check-in service at blackark.uk (hosted by one.com in the EU) and the support board (on a server in the EU, reached only through Cloudflare's secure tunnel) | The check-ins and Help & support requests above | To run trials and licences, and to answer support requests. Only BlackArk staff with their own account and two-step sign-in can see them. [Lawyer to confirm the hosting providers' names and contracts.] |

We have contracts with the providers that process data for us. A current list is kept at
[sub-processor list address] and we tell customers before adding to it.

## Outside the European Economic Area

Our hosting is in Western Europe. Some AI model providers you choose are outside the EEA (for example
in the United States). Where data goes to them, it does so on your instruction, and they transfer it
under safeguards such as the European Commission's standard contractual clauses, which we ask them to
maintain. [Lawyer to confirm the wording per provider.]

## How long we keep it

- **Your account, coworkers, conversations, files and connections:** until you delete them or your
  account.
- **When you delete your account:** everything above is removed (see "Your rights"). Backups fall out of
  our 35-day window by themselves.
- **The record of actions:** 365 days, then removed. It is kept when you delete your account because
  it is a security record; it identifies you only by an internal id, not your name or address.
- **Server logs:** 90 days.
- **The desktop app's check-ins:** the latest check-in of each computer is kept while the trial or
  licence runs, [and for N months after it ends]. Each check-in replaces the one before it.
- **Help & support requests and support emails:** while the request is open, [and for N months after
  it is closed]. A copy of each request you sent also stays on your own computer, under Help &
  support, until you remove the app.
- **Ark Private Server:** while you have it. After you cancel, the server and everything on it are kept
  for 6 days, then deleted.
- **Payment and tax records:** held by Paddle, as the seller, for as long as the law requires.

## Your rights

You can, at any time:

- **See and take a copy of your data**: *Settings → Your data → Download your data* gives you one file.
- **Delete your account and your data**: *Settings → Your data → Delete my account*. Your subscription
  is stopped first. This cannot be undone.
- **Correct** your details: your name and picture come from your sign-in account; change them there, or
  write to us.
- **Object to, or ask us to restrict**, how we use it: write to us.
- **Complain** to a data-protection authority, such as [supervisory authority] or the one where you live.

We answer within one month. We may ask you to confirm who you are, so that we do not give or remove
somebody else's data.

## If your employer or organisation uses Ark

If you use Ark through an organisation's plan, that organisation decides what is put into it and why,
and is the controller for it. We act on its instructions under a data processing agreement. Ask your
organisation first about your data; we will pass your request on to it if you write to us.

## Cookies

Ark uses only the cookie that keeps you signed in. There are no advertising or analytics cookies and no
trackers.

## Security

Keys and tokens are stored encrypted and are never shown or exported. Connections are encrypted. The
database is not reachable from the internet. Access to the systems is restricted, signed in with
multi-factor authentication, and recorded. If a breach puts your rights at risk, we will tell you and the
authority as the law requires.

## Children

Ark is not meant for anyone under 18, and we do not knowingly collect their data.

## Changes

If we change this notice in a way that matters to you, we will tell you in the app before it applies.
