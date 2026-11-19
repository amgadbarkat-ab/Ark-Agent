# Control Board restyle (blackark.uk look)

Status: claimed
Toolkit: Matt Pocock's skills (`/tdd`)
Asked by: Amgad, 19 Nov 2026 13:09 Athens: "i want this board to have the same visuals as our site and CRM,
same icon logo as the website". Brief from PE to sub-agent K.

## What
- Dark theme with the ember accent, Geist and Geist Mono, the blackark.uk header (tile logo + name,
  slate nav links that light up on hover, the gradient primary button), cards and tables like the site.
- Favicons at the site's own paths: `/favicon.ico`, `/favicon-32.png`, `/favicon-192.png`,
  `/apple-touch-icon.png`, byte for byte `brand/official/` (checked equal to the live site on 19 Nov).
- Header logo: `brand/mark.svg`'s geometry, inline in the page (the site does the same).
- Styling and markup only. No behaviour change.

## Colours
The site's values (from blackark.uk's CSS) and `brand/brand-tokens.css` are identical; only names differ:
red = ember `#FF7A1A`, red-deep = ember-deep `#E8650F`, gold = ember-light `#FF9A3C`, hot = flame `#F2551B`.

## Seams under test (taken from PE's brief; a sub-agent cannot confirm them with the user)
1. The board's HTTP `fetch`: brand assets served at their paths, with the right type and the board's
   security headers, before sign-in. Catches missing or wrong assets; misses how they look.
2. Rendered pages: favicon links, the logo, no URL to another origin. Catches external requests creeping
   in; misses visual quality (that is the screenshots).
3. The embedded bytes equal the `brand/` files. Catches drift from the brand folder.

## Security
CSP unchanged except one addition: `font-src 'self'`. `default-src 'none'` blocks every font otherwise,
including a `data:` one, so self-served Geist needs it. Same origin only; scripts and styles unchanged.

## Log
- The four favicons in `brand/official/` are byte for byte what https://blackark.uk serves (SHA-256
  compared on 19 Nov). The site's header logo is an inline SVG with `brand/mark.svg`'s geometry; the board
  does the same.
- Fonts: `brand/fonts/Geist-Variable.woff2` (70 KB) and `GeistMono-Variable.woff2` (71 KB), Vercel, SIL OFL
  1.1 (`brand/fonts/LICENSE.txt`). Variable files, declared as weights 400 to 700 and 400 to 500. No
  subsetting tool is installed (fontTools is absent, and nothing was installed).
- Geist has only six Greek glyphs (λ μ π ω ώ Ω, measured in Chromium), so a Greek word came out in two
  typefaces. The faces now carry a `unicode-range` without Greek, so Greek is wholly the system sans.
  blackark.uk has the same gap: Google Fonts' Geist has no Greek subset.
- Contrast on paper `#070504`: ink 18.2, slate 7.1, ember 7.8, gold 9.6, ok `#3FB97A` 8.2, bad `#FF6B4A`
  7.2; text on ember 7.4. All at least 6.4:1 on the raised surfaces too.
- Two state colours are not the site's: the site's good `#249057` is 4.5:1 on the darkest card, too close
  for small tag text, so tags use a lighter green `#3FB97A`; the site has no error red, and hot `#F2551B` is
  too close to the accent, so errors use `#FF6B4A`.
- The CRM has no public URL; the site's CSS calls itself "BlackArk Cloud design system", which is the look
  followed here.
- Worker bundle (Bun build, minified, as a stand-in for wrangler's esbuild): 317 KB raw, 188 KB gzip.

## Screenshots (made-up data from the test board)
`01-sign-in`, `02-setup`, `03-overview`, `04-customers`, `05-customer`, `06-cases`, `07-case`,
`08-accounts`, `09-billing`, `10-audit`, `11-overview-el`, `12-case-el`, `13-sign-in-el-phone`,
`14-overview-phone`, `15-customers-el-phone`, `16-focus` (keyboard focus on the code field).
