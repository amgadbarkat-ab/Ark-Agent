# Accounts and keys: what Value Data IKE (BlackArk) has to obtain, and how

Written 2026-10-09 for the owner. Everything here is something only the company can do, because it needs
the company's identity, a payment card, or a signature. Each step names the exact setting I will read, so
nothing has to be pasted into a chat: secrets go into GitHub, never into a message or a file in the
repository.

Facts about the stores and the certificate rules were read from the vendors' own pages on 2026-10-09
(links at the end). They change; each section says where to look again. Prices are the vendors' and are
not checked beyond what the page said.

## Start here: what is settled and what is not

Settled by the owner on 2026-10-09:

1. **The legal entity is Value Data IKE**, a Greek private company (ιδιωτική κεφαλαιουχική εταιρεία, ΙΚΕ),
   which is a legal entity in its own right. **BlackArk is its trade name**, not a company. (The website
   calls BlackArk "the successor to Value Data Technology": the D-U-N-S record and every document below
   must be those of the ΙΚΕ, not the older business.) What follows from that:
   - **Apple enrols the legal entity, never a trade name.** Its page says it does not accept "DBAs,
     fictitious businesses, trade names, or branches". So the Apple account is **Value Data IKE**, and the
     seller shown on the App Store is "Value Data IKE", not "BlackArk". The app itself can still be called
     ArkAgent.
   - **Google Play** takes an organisation account on the same legal name and D-U-N-S number. The
     developer name that customers see is a separate field in the Console; check what it offers, because
     Google also shows the verified legal name.
   - **Microsoft's Artifact Signing** validates the legal entity, and the publisher name on the signature
     is that validated name (it cannot be customised). Windows will show "Value Data IKE" as the publisher.
   - **The trademark:** "BlackArk" was cleared in the UK (confirmed 2026-09-04). Ask the lawyer to confirm
     that the mark is, or will be, held by Value Data IKE, since the stores and Microsoft will name that
     company as the seller or publisher.
   - **The company's registered name has to be spelled identically** on the D-U-N-S record, with Apple, with
     Google and with Microsoft. A mismatch is the most common reason an enrolment stalls. Take the spelling
     from the ΓΕΜΗ certificate.
2. **The product runs on `app.blackark.uk`.** The marketing site stays on `www.blackark.uk`. The Android app
   is bound to one host by a file the product serves at `/.well-known/assetlinks.json`, Paddle approves the
   checkout domain by name, and sign-in cookies belong to one host. Needs a DNS record and a certificate
   when the product is deployed (`docs/ark/13-azure-hosting.md`).

Settled by the owner (2026-10-09):

3. **The identifiers: `blackark.arkagent`, for all three.** The owner chose this one name for the Android
   package, the iOS bundle identifier and the desktop app.

   | Where | Identifier | Permanent once published? |
   | --- | --- | --- |
   | Android package name | `blackark.arkagent` | **Yes**, forever |
   | iOS bundle identifier | `blackark.arkagent` | **Yes**, forever |
   | Desktop identifier (macOS and Windows) | `blackark.arkagent` | Effectively yes: it names the app's data folder and its keychain entries. Set in `tauri.conf.json`. |

   Both stores accept a two-part name (checked against the validators in `server/src/mobile/links.ts`; the iOS
   form with a Team ID is `ABCDE12345.blackark.arkagent`). One difference from the usual reverse-domain
   form: it does not start with the country code, so it is not literally the company's domain written
   backwards (`uk.blackark`). That is allowed, and the owner has chosen it. Neither store requires it to
   match a domain.

   The product name is **ArkAgent**, one word, as on the company's website and on the character poster the
   owner supplied (2026-10-09). It has not been cleared as a trademark; see "Where the apps are offered"
   below.

## Order, lead times and costs

D-U-N-S first: it is free but takes days, and both stores need it for an organisation. Everything else can
then run in parallel. The two things nobody can speed up are the D-U-N-S wait and Microsoft's identity
check.

| Step | Cost | Wait (as stated by the vendor) |
| --- | --- | --- |
| D-U-N-S number (Dun & Bradstreet, through Apple's lookup) | Free | Up to 5 business days from D&B, then up to 2 for Apple to receive it. Pay no one who offers to speed it up; Apple and Google both say that does not work. |
| Apple Developer Program (organisation) | 99 USD a year, in local currency where available | Apple verifies first and then sends the way to pay; allow days to a few weeks. Not stated by Apple. |
| Google Play Console | 25 USD once | Identity checks; not stated. |
| Windows signing, Microsoft Artifact Signing | A monthly price per account (Basic: 5,000 signatures a month; the pricing page showed no figure when I read it) plus a paid Azure subscription | Identity validation cannot be expedited; you get three attempts. |
| Windows signing, a certificate from a certificate authority | Vendor's price; renew every year (see below) | Vendor's checks, usually days |
| Apple Developer ID (Mac signing) and notarisation | Included in the Apple membership | Same day once the membership is active |

## 1. A D-U-N-S number (organisation only)

1. Go to Apple's **D-U-N-S lookup** (`developer.apple.com/enroll/duns-lookup`). Enter the legal name, the
   headquarters address, a mailing address and a work contact.
2. If Value Data IKE already has a number, it shows. If not, the same page lets you submit the details to Dun &
   Bradstreet for a **free** number. Have the registration documents from the Greek commercial registry
   (ΓΕΜΗ) to hand: D&B may ask for the business type and number of employees.
3. Allow up to **5 business days**. After 2 weeks without an answer, email D&B. Once you have it, allow up to 2
   business days for Apple to receive it.
4. If Apple later says "your organisation is not listed as a legal entity", the D&B record has a different
   legal status. Email D&B with the registration documents; they correct it. Changes take up to 2 business
   days to reach Apple.

Google's help page says the same free route applies to Google Play, and that the Play developer details must
stay consistent with the D&B profile.

## 2. Google Play Console

**What it unlocks:** the Android app, and the push notifications that ride on it.

1. Use a Google account that belongs to the company (a shared mailbox such as `apps@blackark.uk`, not a
   personal address), with 2-step verification on. It becomes the owner of the Play account.
2. Open the Play Console sign-up (`play.google.com/console/signup`). Choose **Organization**.
3. Enter the exact registered name (Value Data IKE) and address, the D-U-N-S number, a public contact email and phone, and
   the website. Pay the **25 USD** one-off fee by card (prepaid cards are refused). Google may ask for a
   government ID and a card, "both under your legal name".
4. Verify the contact phone and email when asked. A new account may also ask you to confirm access to an
   Android device through the Play Console phone app.
5. Google's closed-test rule (12 testers opted in for 14 days in a row before a first release) applies to
   personal accounts created after 13 November 2023. An organisation account, which is what Value Data IKE
   registers, is not subject to it; confirm this on the Console's Dashboard when you register.
6. Create the app: **All apps, Create app**. Name "ArkAgent" (see the trademark note above), language,
   **App** (not game), **Free**. Play will ask for the package name when the first bundle is uploaded; it must
   be the one in the table above.
7. Turn on **Play App Signing** (it is the default for new apps). Google then keeps the real signing key and
   you sign uploads with an **upload key** that we make:
   ```sh
   keytool -genkeypair -v -keystore ark-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ark-upload
   base64 -w0 ark-upload.jks   # the value for the GitHub secret below; on a Mac: base64 -i ark-upload.jks
   ```
   `keytool` asks for two passwords (keystore and key). Keep the file and both passwords in the company's
   password manager, away from the repository.
8. Give the upload key to the build: in GitHub, **Settings, Environments, New environment** named
   `mobile-release`, then add these secrets (the names the workflow reads):
   `ARK_ANDROID_KEYSTORE_BASE64` (the base64 text above), `ARK_ANDROID_KEYSTORE_PASSWORD`,
   `ARK_ANDROID_KEY_ALIAS` (`ark-upload`), `ARK_ANDROID_KEY_PASSWORD`. And these variables:
   `ARK_ANDROID_APP_ID`, `ARK_APP_URL`, `ARK_APP_NAME`.
9. After the first bundle is uploaded to any track, open **Test and release, App integrity, App signing** in
   the Console and copy the **SHA-256 certificate fingerprint of the app signing key** (not of the upload
   key). That is the server setting `ARK_ANDROID_CERT_SHA256`; it is what makes Android drop the address bar.
   Set it on the server and the site then serves `/.well-known/assetlinks.json`.
10. The store listing needs: the short and full description, a 512 by 512 icon (render it from
    `brand/render-icons.mjs`; `icon-512.png`), a **feature graphic** (1024 by 500), at least two phone
    screenshots, the **privacy policy address** (`/privacy` on the product host), the **Data safety**
    questionnaire, the content rating, the target audience, and **App access**: a working account on a
    plan, with something in it, for the reviewer (`docs/ark/19-mobile.md`).
11. Availability: choose the countries on the **Production, Countries / regions** page. See "Where the apps
    are offered".

Google has also announced a separate identity check for all Android developers, phased in from late 2026.
Sources disagree on the exact dates, so when you register read Google's "Android developer verification"
page; developers publishing through Play go through the Console's own verification.

## 3. Apple Developer Program, and App Store Connect

**What it unlocks:** the iOS app, TestFlight, and (section 4) signing the Mac app.

1. Make an **Apple Account for the company** (a shared mailbox such as `apple@blackark.uk`; the email should be
   on the company's domain, which Apple checks for an organisation) with two-factor authentication on. The
   person who enrols must be the legal age of majority, and an owner, founder, executive or someone with
   legal authority to bind the company.
2. Enrol at `developer.apple.com/programs/enroll`. Choose **Company / Organization**.
3. Enter the exact legal name, the D-U-N-S number and the headquarters address. The company website must be
   public and working, on the company's own domain; social pages are not accepted. Apple may ask for a
   reference who can confirm the person's authority, or for notarised business documents.
4. Apple verifies, then emails the way to pay: **99 USD a year** (local currency where available). Apple says
   to contact them if there is no confirmation within 24 hours of paying. The person who enrols is the
   **Account Holder**.
5. When active, open **Certificates, Identifiers & Profiles, Identifiers, +, App IDs, App** and register the
   bundle identifier `blackark.arkagent`. Note the **Team ID** (Membership details): ten characters.
6. In **App Store Connect, Apps, +, New App**: platform iOS, name, primary language, the bundle identifier
   above, an SKU of your choice (for example `ark-agent-ios`).
7. Make the **App Store Connect API key** the build signs with. App Store Connect, **Users and Access,
   Integrations, App Store Connect API, Team Keys, Generate API Key**; the Account Holder or an Admin can. Name
   it `ark-ios-ci`, give it **Admin** access. The build has Apple create its signing certificate and
   profile on the fly (`-allowProvisioningUpdates`), and I have not been able to confirm that a lower role such
   as App Manager is allowed to; if it is, a later key can be narrowed (Apple lets a key's role change only by
   revoking it and making a new one). Then:
   - copy the **Issuer ID** (shown above the keys table) and the **Key ID**;
   - **download the `.p8` once**: Apple does not offer it again. Keep it in the password manager.
   ```sh
   base64 -w0 AuthKey_XXXXXXXXXX.p8
   ```
8. In the `mobile-release` environment add the secrets `ARK_IOS_ASC_KEY_BASE64` (the base64 text),
   `ARK_IOS_ASC_KEY_ID`, `ARK_IOS_ASC_ISSUER_ID`, and the variables `ARK_IOS_APP_ID` (the Team ID, a dot, then
   the bundle identifier, for example `ABCDE12345.blackark.arkagent`) and `ARK_IOS_URL_SCHEME` (a short
   lower-case word such as `arkagent`).
9. The listing needs: description, keywords, a support address, a **privacy policy address**, the **App
   Privacy** answers, the age rating, export-compliance answers, screenshots for the required iPhone sizes,
   the **1024 by 1024 icon** (`mobile/ios/brand/AppIcon-1024.png`, already made), and **App Review
   information**: a working account on a plan, and a plain note that the app sells nothing and that people
   pay for the service on the website (the wording is in `docs/ark/19-mobile.md`).
10. **Known review risks, which only a submission can settle:** (a) a thin web view can be rejected as
    offering too little beyond the website; (b) an app that signs in with another company's account (Google,
    Microsoft) may be asked for an equivalent privacy-preserving sign-in, which is "Sign in with Apple" or
    another option that meets Apple's rules. Neither is a reason not to try; both are why the first
    submission should go to TestFlight, not to the store.

Notifications on iOS need a separate Apple key (APNs) and a second sending path, which are not built
(`docs/ark/19-mobile.md`).

## 4. Mac signing: the Developer ID certificate and notarisation

**What it unlocks:** a Mac download that opens without a warning. Without it macOS refuses the app.
It needs the paid membership of section 3; the free tier cannot notarise.

1. Only the **Account Holder** can create the certificate (Admins with the cloud-managed access role have
   another route). Make a signing request on any machine:
   ```sh
   openssl req -new -newkey rsa:2048 -nodes -keyout developer-id.key \
     -out developer-id.csr -subj "/CN=Value Data IKE Developer ID/O=Value Data IKE"
   ```
   (On a Mac, Keychain Access, Certificate Assistant, **Request a Certificate From a Certificate Authority**
   does the same and keeps the key in the keychain.)
2. At `developer.apple.com/account/resources`: **Certificates, +, Software, Developer ID, Developer ID
   Application**, upload the request, **Download** the `.cer`.
3. Combine certificate and key into one file the build can use, with a password you choose:
   ```sh
   openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
   openssl pkcs12 -export -inkey developer-id.key -in developer-id.pem -out developer-id.p12
   base64 -w0 developer-id.p12     # on a Mac: openssl base64 -A -in developer-id.p12
   ```
   Delete the loose `.key` afterwards. Keep the `.p12` and its password in the password manager.
4. Notarisation uses an App Store Connect key too. Make a **second** key with **Developer** access, named
   `ark-notarize-ci` (separate from the iOS one so each has only the access it needs), and download its `.p8`
   once.
5. In GitHub, make an environment `macos-signing` and add the names Tauri reads:
   secrets `APPLE_CERTIFICATE` (the base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY` (the Key
   ID), `APPLE_API_ISSUER`, `APPLE_API_KEY_BASE64` (the base64 `.p8`; the job writes it to a temporary file and
   sets `APPLE_API_KEY_PATH`, which is the name Tauri wants), and the variable `APPLE_SIGNING_IDENTITY`
   (`Developer ID Application: Value Data IKE (<Team ID>)`, exactly as the certificate shows).

The workflow that uses these is **not written yet**; it cannot be tested without them, and the first run
will need a Mac to open the result. I write it as soon as the secrets exist, so the first run tests it.

## 5. Windows signing

**What it unlocks:** a Windows installer that names the company as publisher. Without it SmartScreen shows
"unknown publisher". Even signed, a new program is flagged until enough people have downloaded it; reputation
builds with use. (Microsoft's service does not issue EV certificates and says it will not.)

### Option A (recommended; Value Data IKE is an EU company): Microsoft Artifact Signing

Formerly Trusted Signing. Public-trust certificates are open to **organisations in the EU** (and the US,
Canada, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel).
Individuals only in the United States and Canada, which does not matter here: Value Data IKE applies as an organisation.
There is no certificate to buy, store, renew or lose: Microsoft's service signs, and the certificate it
issues lasts three days, which is why a timestamp is always added.

1. A **paid** Azure subscription (pay-as-you-go or an agreement; free, trial and sponsored subscriptions are
   refused). The hosting subscription from `docs/ark/13-azure-hosting.md` can be the one.
2. In the subscription, **Resource providers**: register `Microsoft.CodeSigning`.
3. Create an **Artifact Signing account** in **West Europe** (endpoint `https://weu.codesigning.azure.net`;
   the endpoint must match the region of the account and the profile, or signing fails with a 403). Pick the
   Basic tier.
4. Give yourself the role **Artifact Signing Identity Verifier**, then **Identity validation, New identity,
   Organization**. Enter the exact legal name and address, and the primary email. A link goes to that email
   and **expires in 7 days**; if it expires, start again. Upload the registration documents: each must be
   **issued within the previous 12 months**. There are three attempts and it cannot be hurried. The name Microsoft validates becomes
   the certificate's publisher name and cannot be customised.
5. **Certificate profiles, Create, Public Trust**, attached to the validated identity. Name it `ark-desktop`.
6. Let GitHub sign without a password: in Microsoft Entra, **App registrations, New registration** `ark-signing`.
   On it, **Certificates & secrets, Federated credentials, Add, GitHub Actions deploying Azure resources**:
   organisation `amgadbarkat-ab`, repository `Ark-Agent`, entity type **Environment**, environment name
   `windows-signing`. (It is case-sensitive. If the repository moves to a company GitHub organisation this
   must be redone; `desktop/signing/azure-federation.json` holds the same values.) Then give that app
   registration the role **Artifact Signing Certificate Profile Signer** on the signing account.
7. In GitHub, environment `windows-signing`, set the variables `AZURE_CLIENT_ID` (the app's Application
   ID), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and the three I will read for the service:
   `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`. No secret is needed.
8. **The workflow has to change when this is chosen.** `.github/workflows/desktop-signing.yml` signs with a
   certificate held in Azure Key Vault (the variables `AZURE_KEY_VAULT_URL` and `CODE_SIGNING_CERT_NAME`)
   through AzureSignTool. With Artifact Signing it signs through the service instead (SignTool with
   Microsoft's client library, or Microsoft's GitHub action `azure/artifact-signing-action`). I make that
   change when you choose this option; it cannot be tested before the account exists.

### Option B: a certificate from a certificate authority

Only if the validation in A fails. Two rules to know before buying:

- Since June 2023 the private key of an OV or EV code-signing certificate has to live on hardware that meets
  FIPS 140 Level 2 or Common Criteria EAL 4+: a token the authority posts you, or the authority's cloud
  signing service. A downloadable `.pfx` is no longer sold. The CI therefore needs the authority's **cloud
  signing**, not a file.
- Since 1 March 2026 such certificates last at most **460 days**, so budget a renewal every year.

Ask the authority for cloud signing that works from GitHub Actions. If the certificate is to sit in Azure
Key Vault (what the current workflow assumes), the authority must accept key attestation from a Key Vault
HSM; many do not, which is why A is simpler.

## 6. All the names in one place

| GitHub environment | Name | Kind | Where it comes from |
| --- | --- | --- | --- |
| `mobile-release` | `ARK_ANDROID_APP_ID`, `ARK_APP_URL`, `ARK_APP_NAME`, `ARK_IOS_APP_ID`, `ARK_IOS_URL_SCHEME` | variables | the identifiers above |
|  | `ARK_ANDROID_KEYSTORE_BASE64`, `ARK_ANDROID_KEYSTORE_PASSWORD`, `ARK_ANDROID_KEY_ALIAS`, `ARK_ANDROID_KEY_PASSWORD` | secrets | the upload key (section 2) |
|  | `ARK_IOS_ASC_KEY_BASE64`, `ARK_IOS_ASC_KEY_ID`, `ARK_IOS_ASC_ISSUER_ID` | secrets | the App Store Connect key (section 3) |
| `macos-signing` | `APPLE_SIGNING_IDENTITY` | variable | the certificate |
|  | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_BASE64` | secrets | section 4 |
| `windows-signing` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE` | variables | section 5, option A |
| The running product (Azure, not GitHub) | `ARK_ANDROID_APP_ID`, `ARK_ANDROID_CERT_SHA256`, `ARK_IOS_APP_ID`, `ARK_IOS_URL_SCHEME` | server settings | `docs/ark/19-mobile.md` |

On each environment turn on **Required reviewers**, so a signing key is only ever used by a run you
approved. Keep every `.p8`, `.p12`, `.jks` and password in the company's password manager and nowhere else.

## Where the apps are offered

"BlackArk" is cleared only in the United Kingdom, and "ArkAgent" has not been checked at all. Both stores let
the company choose the countries an app is offered in, and both show the developer's name and the app's name
to the public. Until the lawyer has answered, the safer first listing is **United Kingdom only**, widened
country by country as clearance comes. That is a business and legal call, not an engineering one.

## What I do when each piece arrives

| Arrives | I do |
| --- | --- |
| The decisions at the top | Set the identifiers in the config, change the desktop identifier, point `assetlinks` at the product host, and update `desktop/signing/azure-federation.json` and `docs/windows-signing.md`. |
| Google Play account + upload key secrets | Run the Android workflow by hand, fix what the first real run shows, and tell you how to upload the bundle to an internal test track. |
| Apple account + App Store Connect key | Run the iOS workflow (never run yet, and the iOS project has never been compiled), fix what Xcode finds, and put the first build on TestFlight. |
| Apple Developer ID secrets | Write and run the macOS signing and notarisation job. |
| Windows signing set up | Change the Windows workflow to the chosen option and run it. |

## Sources (read 2026-10-09)

- Apple, [enrolling as an organisation or individual](https://developer.apple.com/support/enrollment/) and
  [D-U-N-S numbers](https://developer.apple.com/help/account/membership/D-U-N-S/)
- Apple, [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
  and [App Store Connect API keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
- Google, [creating a Play Console developer account](https://support.google.com/googleplay/android-developer/answer/6112435)
  and [using a D-U-N-S number](https://support.google.com/googleplay/android-developer/answer/13634885)
- Microsoft, [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart),
  [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) and
  [signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)
- Tauri, [macOS code signing and notarisation](https://v2.tauri.app/distribute/sign/macos/)
