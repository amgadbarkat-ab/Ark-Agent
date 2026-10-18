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

## The characters

The owner supplied two pieces of artwork on 2026-10-09, both in the v3 (Ember) colours: black figures in black
suits with a headset and ember-orange accents, wearing the BlackArk tile as a lapel pin.

- **ArkAgent** (`arkagent/arkagent-poster.webp`, unaltered, 864 by 1152). One digital employee, shown as the
  Sales character. It is the face of the product: the head and shoulders are cut from it into
  `arkagent/portrait.jpg` and shown beside the name on the desktop's Welcome screen, on the web app's welcome
  and terms screens (where the animated orb was) and beside the ArkAgent plan on the Plan screen.
- **Ark Team** (`arkteam/arkteam-roster.webp`, unaltered, 1280 by 720). The full digital roster of eight roles:
  Sales, Marketing, Accounting, Inventory and logistics, Finance ("Named person approves."), Chief of
  operations, Chief of staff and Front desk. Each is cut into `arkteam/roles/<role>.jpg`, and four together
  into `arkteam/team-faces.jpg`, which stands for Ark Team (and Ark Team Enterprise) on the Plan screen.
  The website's list has nine roles; the roster has eight, so the ninth has no picture yet.

`render-icons.mjs` makes every crop from the originals and copies them to `app/public/brand/` (and
`desktop/src/assets/`). The coworkers a person creates keep their own orbs; these characters are the
products' faces, not coworkers. The wording on the posters is the company's own product copy and can be used
for store listings once the owner approves it: "One digital employee", "Runs a written routine", "A person
keeps judgment", "Hands off outside the procedure", "Built to transform. Built to distribute."

An earlier poster the owner sent the same day (the same figure in gold, with the retired v2 logo) was replaced
by these and is not kept.

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
| Web app (installable app, browser tab, push) | `app/public/icons/icon-192.png`, `icon-512.png`, `icon.svg` | The character's head, cropped from `arkagent/icon-source.webp` in the owner's framing, in a circle. |
|  | `apple-touch-icon.png`, `icon-maskable-512.png`, `icon-maskable.svg` | Flat squares: iOS rounds its own corners, and a launcher cuts a maskable icon's shape, so the maskable one keeps the head inside the 80% circle any mask leaves. |
| In the app (top-left logo, every Bot's default picture) | `app/public/brand/arkagent-icon.jpg` | 256 square, rounded by the screen. |
| Android app | `mobile/android/app/src/main/res/` adaptive icon (`mipmap-anydpi-v26`, `drawable-xxxhdpi/ic_launcher_foreground.png`, `values/ic_launcher_background.xml`) | The picture's own dark as the background and the head inside the 66 dp circle every launcher shows. No themed layer: a picture has no silhouette to tint. |
|  | `mipmap-xxxhdpi/ic_launcher.png` | The 192 round icon, for phones too old for an adaptive icon. |
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
