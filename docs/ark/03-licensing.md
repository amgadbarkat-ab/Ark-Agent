# Licensing: what we may reuse

Updated 2026-10-08. Not legal advice: have a lawyer confirm before we ship or sell anything.

## Decision

Ark is built by taking CopilotKit's OpenBot (MIT) directly and modifying it (decision D1).

| Project | License | Can Ark reuse its code? |
| --- | --- | --- |
| CopilotKit OpenBot (in this repo) | MIT | **Yes**, including commercially. Keep the copyright and licence notice. |
| openbot.run (nightly-labs/openbot) | PolyForm Noncommercial 1.0.0 | **No.** Commercial use needs their separate licence. |
| Bops (OrgoAI/bops-oss) | FSL-1.1-ALv2 (Functional Source License) | **No, not now.** See below. |
| Hark, James AI | Closed | No code available. |

## What "MIT" covers here

- The repo's own code is MIT (`LICENSE`, copyright 2026 CopilotKit). We may use, modify and sell it.
  Keep that notice and add our own copyright line for our changes.
- The `@copilotkit/*` npm packages the code depends on were checked in `node_modules` and are all MIT
  (runtime, core, shared, react-core, channels-*, license-verifier, web-components, and others).
  Their transitive dependencies still need a full licence scan before release.
- **CopilotKit Intelligence is a separate hosted service** with its own terms. The MIT licence on the
  code does not give us the service. The code requires it to start, which is why replacing it comes
  first in the build plan (05-build-plan.md). The SDK client for it is MIT, so removing the calls is
  allowed.
- **Trademarks.** MIT does not grant the right to use CopilotKit's names or logos. Remove them from
  anything customer-facing. "OpenBot" is also the name of another company's product (openbot.run),
  so Ark must not ship under that name either.

## Bops: Functional Source License

Any purpose is allowed except a **Competing Use**: making the software available to others in a
commercial product or service that substitutes for it or offers the same or substantially similar
functionality. Ark would be a competing use, so we cannot build on Bops code. Each version converts
to Apache 2.0 on the second anniversary of its release, which does not help our timeline.

## Rules for the team

1. Never copy code from openbot.run or Bops into Ark. Public product behaviour and ideas are fine.
2. Run a licence scan on all dependencies before the first release and keep a NOTICE file.
3. Do not add dependencies with non-commercial, source-available or copyleft (GPL/AGPL) licences
   without a decision, because Ark is sold as a service and shipped as apps.
4. Model weights have their own licences. Only bundle or recommend models whose licences allow
   commercial use, and re-check at release time.
