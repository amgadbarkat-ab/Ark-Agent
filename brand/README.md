# Brand

Ark Agent uses Black Ark's own identity: **BlackArk Visual Identity v3 (Ember)**, issued 4 October 2026
by the company (its `brand-tokens.json`, kept here as read from the company's OneDrive). Nothing in this repository invents
a mark, a colour or a name; if the company changes its identity, this folder is where the change starts.

## What is here

| File | What it is |
| --- | --- |
| `brand-tokens.json` | The company's v3 token file as read from its OneDrive (`Chief of Operations/visual-identity/v3-ember/`). The reading tool may have turned a dash into a hyphen in the names, so the original there is the authority; the values are exact. The colours, type and rules below come from it. |
| `mark.svg` | The app tile: an ember square with three ascending bars, as the company publishes it on its website (its favicon and home-screen icon). |
| `official/` | The company's own published icon files (`favicon.ico`, `favicon-32.png`, `favicon-192.png`, `apple-touch-icon.png`). Used as they are, not redrawn. |
| `render-icons.mjs` | Draws every other icon Ark ships from `mark.svg` and writes it where it is used. |
| `brand.test.ts` | Checks that every icon in the repository is the brand's: the right colours, sizes and kinds, and that the copies of the company's files have not drifted. |

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
- The wordmark and lockup ("Logo 08, Ligature Lockup") are in the company's pack as SVG and a zip that
  could not be fetched through the connection used here. They are not imported. Store listings need
  them (and screenshots, a feature graphic for Google Play, and a short description), so the company
  should supply them from its pack.
- Fonts are not bundled. Geist is open-licensed and can be, once the interface is moved to the tokens.
- The desktop app's own wording (setup window, messages, tray, installer) now says Ark Agent. What was left alone
  on purpose is listed in `docs/ark/10-desktop-replatform.md`.
- Nothing has been looked at on a real phone, Mac or Windows machine.
