# Brand

ArkAgent uses Black Ark's own identity: **BlackArk Visual Identity v3 (Ember)**, issued 4 October 2026
by the company and handed over as a kit by the owner on 2026-10-09. Its token file is kept here exactly as
issued. Nothing in this repository invents a mark, a colour or a name; if the company changes its identity,
this folder is where the change starts.

## What is here

| File | What it is |
| --- | --- |
| `brand-tokens.json`, `brand-tokens.css` | The company's v3 token files, exactly as issued in the kit. The colours, type and rules below come from them. |
| `mark.svg` | The app tile: an ember square with three ascending bars, as the company publishes it on its website (its favicon and home-screen icon). |
| `official/` | The company's own published icon files (`favicon.ico`, `favicon-32.png`, `favicon-192.png`, `apple-touch-icon.png`), identical to the kit's `favicon/`. Used as they are, not redrawn. |
| `logos/` | The company's logo files: the lockups on dark, on light and transparent, and the three-bar icon as PNG and as true vector. For store listings, the About screen and documents; the app tile above is what goes on a home screen. |
| `fonts/` | Geist and Geist Mono (SIL Open Font License; the licence text is in the folder). Kept for when the interface moves to the v3 type; not loaded by any screen yet. |
| `og-image.png` | The 1200 by 630 share image, the same file the website serves. |
| `arkagent/` | **The ArkAgent character**: the owner's poster (`arkagent-poster.jpg`, unaltered) and the head and shoulders cropped from it (`portrait.jpg`). See below. |
| `render-icons.mjs` | Draws every other icon Ark ships from `mark.svg` and writes it where it is used. |
| `brand.test.ts` | Checks that every icon in the repository is the brand's: the right colours, sizes and kinds, and that the copies of the company's files have not drifted. |

Not copied from the kit, on purpose: the staff cards and the e-mail signatures (they are about named people),
the letterhead and the quotation and invoice templates (they are the company's office documents, not the
product's), and the PDF guide (it is the company's to keep; the rules that matter to the product are
summarised below).

## The ArkAgent character

On 2026-10-09 the owner supplied a poster of the product's character: a dark humanoid in a black suit with
a headset and gold accents, with the line "Your business AI assistant" and four promises (trusted, insightful,
efficient, professional). It is **the face of ArkAgent**, the product's own persona. The coworkers a person
creates keep their own orbs.

- `arkagent/arkagent-poster.jpg` is kept exactly as supplied (768 by 1152).
- `render-icons.mjs` crops the head and shoulders into `arkagent/portrait.jpg` and copies it to
  `app/public/brand/` and `desktop/src/assets/`. It is shown beside the name on the desktop's Welcome screen
  and on the web app's welcome and terms screens, where the animated orb was.
- **Two things on the poster are not the current identity, so only the figure is used.** Its logo ("BlackArk.uk
  BUSINESS AI" with a gold "B") is the retired v2 mark, and its gold is the retired v2 accent; v3 (Ember)
  replaced both on 2026-10-04. The character's own gold details (the head plate, the headset ring, the pocket
  square) were left as drawn. If the company wants them recoloured ember to match v3, that is a change to the
  artwork, not to the code.
- Its words are usable as store-listing copy once the owner approves them: "Intelligent. Reliable.
  Professional.", "Your business AI assistant", "Intelligent AI. Real business impact."

## The rules that matter for the product

- **Ember `#FF7A1A`** is the accent. **`#1A0B03`** is the text and the bars on ember. Dark surfaces are
  paper `#070504` and raised paper `#110B07`; text on dark is `#F3F2EF`.
- Ember on white fails contrast for text (2.6:1). Where ember-coloured text has to sit on a light
  background use Ember Ink `#B84A00` (5.2:1). Ember is for graphics and for large fills there.
- Type is Geist and Geist Mono (SIL Open Font License).
- The tagline is "Built to transform. Built to distribute." Say "digital transformation and SaaS
  products" first.
- **The name "BlackArk" is cleared as a trademark in the United Kingdom only** (confirmed 4 September 2026).
  Greece, the EU and the Middle East are still open. Until they are, treat anything that puts the name in
  front of customers outside the UK (store listings in other countries, the Apple and Google
  developer names) as a decision for the company's lawyer. `docs/ark/20-accounts-and-keys.md` repeats this where it
  matters.
- The company's registered address and tax number are on its own website and are not copied into this
  repository.

## Where each icon lands

| Where | Files | How |
| --- | --- | --- |
| Web app (installable app, browser tab, push) | `app/public/icons/icon-192.png`, `apple-touch-icon.png` | The company's own files, copied. |
|  | `icon-512.png`, `icon-maskable-512.png`, `icon.svg`, `icon-maskable.svg` | Drawn from `mark.svg`. The maskable one is full-bleed with the bars at 90%, so a launcher's circular mask never cuts them. |
| Android app | `mobile/android/app/src/main/res/` adaptive icon (`mipmap-anydpi-v26`, `drawable/ic_launcher_foreground.xml`, `values/ic_launcher_background.xml`) | Ember background, bars sized to stay inside the 66 dp circle every launcher shows, and a monochrome layer for Android 13 themed icons. |
|  | `mipmap-xxxhdpi/ic_launcher.png` | The company's 192 file, for phones too old for an adaptive icon. |
| iOS app | `mobile/ios/brand/AppIcon-1024.png` | 1024 by 1024, flat, no transparency (the App Store refuses it). `mobile/scripts/ios-config.ts` checks it before every build. |
| Desktop app | `desktop/src-tauri/icons/icon.png` and everything made from it | The master is drawn here; the platform sizes come from `tauri icon` (`desktop/src-tauri/icons/README.md`). |

## Making the icons again

```sh
# Needs Playwright and a Chromium. Point at them if they are not already importable:
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node brand/render-icons.mjs
bun test brand
```

The script is deterministic: running it again changes no file. After it, make the desktop's platform sizes
from the new master as `desktop/src-tauri/icons/README.md` says.

## What this does not do yet

- **The web app's screens are still the inherited OpenBot design**: its own greys, its own type. Moving
  the interface to the v3 tokens (ember accent, paper surfaces, Geist) is a design change to every
  screen and is not done. It needs a decision on how far to go, and on whether the product is dark first.
- The lockup and fonts are in this folder but no screen uses them yet. Store listings also need screenshots,
  a feature graphic for Google Play (1024 by 500) and a short description, which are the company's to
  supply or approve.
- The lockup PNGs are recoloured from the v2 artwork, so their lettering still uses a stand-in typeface
  (the kit's own note); real Geist is in `fonts/` for the next regeneration.
- The desktop app's own wording (setup window, messages, tray, installer) now says ArkAgent. What was left alone
  on purpose is listed in `docs/ark/10-desktop-replatform.md`.
- Nothing has been looked at on a real phone, Mac or Windows machine.
