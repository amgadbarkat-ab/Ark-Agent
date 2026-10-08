# Licensing: what we may reuse

Written 2026-10-08. Not legal advice: have a lawyer confirm before we ship or sell anything.

| Project | License | Can Ark reuse its code? |
| --- | --- | --- |
| CopilotKit OpenBot (in this repo) | MIT | **Yes**, including commercially. Keep the copyright notice. |
| openbot.run (nightly-labs/openbot) | PolyForm Noncommercial 1.0.0 | **No.** Commercial use needs a separate license from them. |
| Bops (OrgoAI/bops-oss) | FSL-1.1-ALv2 (Functional Source License) | **No, not now.** See below. |
| Hark, James AI | Closed | No code available. |

## Bops: Functional Source License

The license allows any purpose except a **Competing Use**: making the software available to others
in a commercial product or service that substitutes for it or offers the same or substantially
similar functionality. Ark (an AI-bots-for-business subscription) would be a competing use, so we
cannot build on Bops code.

The license converts to Apache 2.0 on the second anniversary of each version's release. After
that, that version could be used freely. That does not help Ark's timeline now.

## What this leaves

The only code we are allowed to build on is CopilotKit's OpenBot (MIT) and other
permissively licensed open-source libraries. Rules:

1. Do not copy code from openbot.run or Bops into Ark. Ideas and public product behaviour are fine;
   copying code or closely cloning their implementation is not.
2. Keep MIT notices for CopilotKit's code. The MIT license applies to that repo's code only: its
   dependencies carry their own licenses and still need an audit (for example with a license
   scanner) before release.
3. The CopilotKit Intelligence service is a separate hosted product with its own terms. The MIT
   license on OpenBot does not cover it. This is a further reason to replace it (decision D1).
4. Product names: "OpenBot" is also openbot.run's product name. Ark should not ship under that
   name.
