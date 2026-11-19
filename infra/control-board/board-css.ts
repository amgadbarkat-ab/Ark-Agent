/** BlackArk Control Board styles, served as /board.css (the CSP allows styles from the board only). In a
 * string, because a Worker has no files to read at run time.
 *
 * The look is blackark.uk's (BlackArk Visual Identity v3, Ember; brand/brand-tokens.css): one dark theme,
 * the ember accent, Geist and Geist Mono. The fonts are the board's own copies of brand/fonts, served at
 * /fonts/ (brand-assets.ts); nothing is loaded from another site. */
export const CSS = `/* BlackArk Control Board. Served as /board.css; the CSP allows styles and fonts from this server only. */
@font-face {
  font-family: "Geist";
  src: url("/fonts/geist.woff2") format("woff2");
  font-weight: 400 700;
  font-style: normal;
  font-display: swap;
  /* Not Greek: Geist has only a few Greek letters (λ μ π ω), so a Greek word would mix two typefaces. */
  unicode-range: U+0000-036F, U+0400-1EFF, U+2000-10FFFF;
}
@font-face {
  font-family: "Geist Mono";
  src: url("/fonts/geist-mono.woff2") format("woff2");
  font-weight: 400 500;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-036F, U+0400-1EFF, U+2000-10FFFF;
}
:root {
  /* blackark.uk's own names and values (the same as brand/brand-tokens.css). */
  --paper: #070504;
  --paper-raised: #110b07;
  --card-dark: #160f0a;
  --card-dark-raised: #1b130e;
  --ink: #f3f2ef;
  --slate: #9b9893;
  --red: #ff7a1a;
  --red-deep: #e8650f;
  --red-fg: #1a0b03;
  --gold: #ff9a3c;
  --hot: #f2551b;
  --good: #249057;
  --line: rgba(255, 255, 255, 0.11);
  --line-strong: rgba(255, 255, 255, 0.2);
  --grad: linear-gradient(105deg, #ffb067 0%, #ff7a1a 38%, #f2551b 78%, #e5481a 100%);
  --button: linear-gradient(105deg, #ff9a3c, #ff7a1a 55%, #f2551b);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 16px 32px -16px rgba(0, 0, 0, 0.65);
  --sans: "Geist", -apple-system, "Segoe UI", system-ui, sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  /* What the board's states mean, in the brand's colours. Every one is at least 4.5:1 on paper. */
  --ok: #3fb97a;
  --warn: var(--gold);
  --bad: #ff6b4a;
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
html {
  background: var(--paper);
}
body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink);
  background:
    radial-gradient(60rem 22rem at 85% -6rem, rgba(255, 122, 26, 0.09), transparent 70%),
    var(--paper);
  -webkit-font-smoothing: antialiased;
}
::selection {
  background: rgba(255, 122, 26, 0.35);
}
a {
  color: var(--red);
  text-underline-offset: 3px;
}
a:hover {
  color: var(--gold);
}
:focus-visible {
  outline: 2px solid var(--red);
  outline-offset: 2px;
}

/* Header: blackark.uk's bar. */
header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(7, 5, 4, 0.88);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
header .bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 1.1rem;
  max-width: 76rem;
  margin: 0 auto;
  padding: 0.8rem 1.25rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--ink);
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  text-decoration: none;
  white-space: nowrap;
}
.brand:hover {
  color: var(--ink);
}
.brand svg {
  flex: none;
  width: 26px;
  height: 26px;
}
/* The menu: a row of tabs under the brand, so a longer (Greek) menu never pushes the brand around. */
header nav {
  order: 3;
  flex: 1 1 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 0.1rem;
  margin: 0 -0.7rem -0.8rem;
}
header nav a {
  color: var(--slate);
  font-size: 14px;
  text-decoration: none;
  padding: 0.55rem 0.7rem 0.65rem;
  border-radius: 8px 8px 0 0;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
header nav a:hover {
  color: var(--ink);
  background: var(--paper-raised);
}
header nav a[aria-current="page"] {
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--red);
}
header nav a:focus-visible {
  outline-offset: -2px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  margin-inline-start: auto;
}
a.lang {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  white-space: nowrap;
}
a.lang:hover {
  border-color: var(--red);
  color: var(--ink);
}
.signout {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  color: var(--slate);
  font-size: 13px;
}

/* Page */
main {
  max-width: 76rem;
  margin: 0 auto;
  padding: 1.75rem 1.25rem 3rem;
}
h1,
h2,
h3 {
  font-weight: 600;
  letter-spacing: -0.02em;
  text-wrap: balance;
  overflow-wrap: anywhere;
}
h1 {
  font-size: 1.75rem;
  line-height: 1.2;
  margin: 0 0 1.5rem;
}
h1::after {
  content: "";
  display: block;
  width: 64px;
  height: 3px;
  margin-top: 0.7rem;
  border-radius: 3px;
  background: var(--grad);
}
h2 {
  font-size: 1.15rem;
  margin: 2rem 0 0.75rem;
}
h3 {
  font-size: 0.95rem;
  margin: 1.25rem 0 0.5rem;
  color: var(--slate);
}
h2 small,
h3 small {
  color: var(--slate);
  font-weight: 500;
}
p {
  margin: 0.6rem 0;
}

/* Cards: the site's raised panels. */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.9rem;
}
.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 1rem 1.1rem;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  transition: border-color 0.2s ease;
}
.tile:hover {
  border-color: rgba(255, 122, 26, 0.45);
}
.tile .n {
  font-size: 2rem;
  line-height: 1.15;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.tile a,
.tile span:not(.n) {
  color: var(--slate);
  font-size: 13.5px;
  text-decoration: none;
}
.tile a:hover {
  color: var(--ink);
}
.tile a::after {
  /* The whole card opens the list. */
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 12px;
}
.tile:has(a:focus-visible) {
  outline: 2px solid var(--red);
  outline-offset: 2px;
}
.tile a:focus-visible {
  outline: none;
}
.tile.warn {
  border-color: rgba(255, 154, 60, 0.55);
  background: linear-gradient(180deg, rgba(255, 154, 60, 0.08), transparent 70%), var(--paper-raised);
}
.tile.warn .n {
  color: var(--gold);
}

/* Tables: the CRM's lists. */
.scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper-raised);
}
table {
  border-collapse: collapse;
  width: 100%;
  background: var(--paper-raised);
  font-size: 14px;
}
main > table {
  border: 1px solid var(--line);
  border-radius: 12px;
  border-collapse: separate;
  border-spacing: 0;
  overflow: hidden;
}
th,
td {
  text-align: start;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
tbody tr:last-child td {
  border-bottom: 0;
}
th {
  background: var(--card-dark);
  color: var(--slate);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
tbody tr:hover td {
  background: rgba(255, 255, 255, 0.025);
}
td {
  font-variant-numeric: tabular-nums;
}
tr.refused td {
  color: var(--bad);
}

/* Tags: the site's chips. */
.tag {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  padding: 0.05rem 0.55rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  white-space: nowrap;
  color: var(--ink);
  border-color: var(--line-strong);
}
.tag.ok {
  color: var(--ok);
  border-color: currentColor;
  background: rgba(36, 144, 87, 0.12);
}
.tag.warn {
  color: var(--warn);
  border-color: currentColor;
  background: rgba(255, 154, 60, 0.1);
}
.tag.bad {
  color: var(--bad);
  border-color: currentColor;
  background: rgba(255, 107, 74, 0.12);
}
.muted,
.tag.muted {
  color: var(--slate);
}
.tag.muted {
  border-color: var(--line-strong);
}

/* Notices */
.error,
.info {
  padding: 0.7rem 0.9rem;
  border: 1px solid var(--line);
  border-inline-start: 3px solid var(--red);
  border-radius: 8px;
  background: var(--paper-raised);
}
.error {
  color: var(--bad);
  border-inline-start-color: var(--bad);
  background: rgba(255, 107, 74, 0.07);
}
.info p {
  margin: 0.3rem 0;
}

/* Forms */
.stack {
  display: grid;
  gap: 1rem;
  max-width: 28rem;
  margin: 1rem 0;
  padding: 1.25rem;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
}
.stack label {
  display: grid;
  gap: 0.35rem;
  font-size: 14px;
  font-weight: 500;
}
.stack label small {
  font-weight: 400;
}
.stack button {
  justify-self: start;
}
.stack p {
  margin: 0;
}
input,
select,
textarea {
  font: inherit;
  font-weight: 400;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--paper);
  color: var(--ink);
  min-width: 0;
}
input::placeholder,
textarea::placeholder {
  color: var(--slate);
}
input:hover,
select:hover,
textarea:hover {
  border-color: rgba(255, 255, 255, 0.32);
}
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  border-color: var(--red);
  outline: 2px solid rgba(255, 122, 26, 0.45);
  outline-offset: 0;
}
input[name="code"] {
  font-family: var(--mono);
  font-size: 1.15rem;
  letter-spacing: 0.25em;
}

/* Buttons: blackark.uk's primary (ember gradient) and ghost. */
button,
.button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font: inherit;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.3;
  padding: 0.65rem 1.15rem;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
  text-decoration: none;
  color: var(--red-fg);
  background: var(--button);
  box-shadow:
    0 0 0 1px rgba(255, 154, 60, 0.5),
    0 10px 30px -8px rgba(255, 90, 16, 0.55);
  transition:
    transform 0.15s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;
}
button:hover,
.button:hover {
  color: var(--red-fg);
  transform: translateY(-1px);
  box-shadow:
    0 0 0 1px rgba(255, 176, 103, 0.8),
    0 14px 36px -8px rgba(255, 90, 16, 0.7);
}
button.ghost {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.03);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  font-size: 13.5px;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
}
button.ghost:hover {
  color: var(--ink);
  background: rgba(255, 122, 26, 0.08);
  box-shadow: inset 0 0 0 1px var(--red);
  transform: none;
}
button.ghost.danger:hover {
  color: var(--bad);
  box-shadow: inset 0 0 0 1px var(--bad);
}
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
  }
  button:hover,
  .button:hover {
    transform: none;
  }
}
form.inline {
  display: inline;
}

/* Mono: keys, ids, times. */
code,
.secret {
  font-family: var(--mono);
  font-size: 0.9em;
  overflow-wrap: anywhere;
}
td code,
li code {
  padding: 0.05rem 0.35rem;
  border-radius: 5px;
  background: var(--card-dark-raised);
}
.secret {
  display: inline-block;
  margin: 0.4rem 0;
  padding: 0.5rem 0.75rem;
  font-size: 1.1rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--gold);
  background: var(--card-dark-raised);
  border: 1px solid var(--line);
  border-radius: 8px;
}
ol,
ul {
  padding-inline-start: 1.25rem;
}
ol li {
  margin: 0.4rem 0;
}
.timeline,
.services {
  list-style: none;
  padding: 0;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper-raised);
}
.timeline li,
.services li {
  margin: 0;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--line);
}
.timeline li:last-child,
.services li:last-child {
  border-bottom: 0;
}
.timeline time {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--slate);
  font-variant-numeric: tabular-nums;
  margin-inline-end: 0.6rem;
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.5rem 1.5rem;
  margin: 0 0 1rem;
  padding: 1rem 1.25rem;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.facts dt {
  color: var(--slate);
  font-size: 13.5px;
}
.facts dd {
  margin: 0;
}
.group {
  margin-bottom: 1.5rem;
}
.group ul {
  padding-inline-start: 1.1rem;
}
.group li {
  margin: 0.3rem 0;
}

/* Filters and pager: the site's chips. */
.filters,
.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.filters a,
.filters strong,
.pager a {
  font-size: 13px;
  font-weight: 500;
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  color: var(--ink);
  text-decoration: none;
}
.filters a:hover,
.pager a:hover {
  color: var(--ink);
  border-color: var(--red);
}
.filters strong {
  color: var(--red-fg);
  background: var(--red);
  border-color: var(--red);
  font-weight: 600;
}
.pager {
  margin-top: 1rem;
  color: var(--slate);
  font-size: 13px;
}

@media (max-width: 40rem) {
  header .bar {
    padding: 0.7rem 1rem;
  }
  header nav {
    margin-inline: -0.5rem;
  }
  header nav a {
    padding-inline: 0.5rem;
  }
  main {
    padding: 1.25rem 1rem 2.5rem;
  }
  h1 {
    font-size: 1.45rem;
  }
  .stack {
    padding: 1rem;
  }
}
`;
