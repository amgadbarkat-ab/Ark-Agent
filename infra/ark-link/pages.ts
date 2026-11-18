/**
 * The relay's own pages, in Greek first and English under it: the customers are in Greece, and a page
 * a person sees before they have chosen a language says both.
 *
 * No script inline (the policy is `script-src 'self'`); the pairing page's script is served beside it.
 * Nothing here comes from a request, so nothing needs escaping.
 */

const STYLE = `
:root{color-scheme:light dark;--bg:#0f1115;--fg:#f3f4f6;--muted:#9ca3af;--card:#1a1d24;--line:#2a2f3a;--accent:#e5622b}
@media (prefers-color-scheme: light){:root{--bg:#f7f7f8;--fg:#111827;--muted:#4b5563;--card:#fff;--line:#e5e7eb}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:1.25rem;margin:0 0 4px}
.en{color:var(--muted);font-size:.9rem;margin:0 0 16px}
label{display:block;font-weight:600;margin:16px 0 4px}
label span{font-weight:400;color:var(--muted)}
input{width:100%;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit}
#code{font-family:ui-monospace,monospace;font-size:1.4rem;letter-spacing:.15em;text-transform:uppercase}
button{margin-top:20px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff}
button[disabled]{opacity:.6}
#status{margin-top:16px;min-height:3em}
#status p{margin:0}
`;

function page(title: string, body: string, script?: string): string {
  return `<!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script src="${script}"></script>` : ""}
</body>
</html>
`;
}

/** Served with `script-src 'self'` and nothing else from elsewhere. */
export const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const PAIR_PAGE = page(
  "ArkAgent: σύνδεση κινητού",
  `<h1>Σύνδεση με τον υπολογιστή σας</h1>
<p class="en">Connect to your computer</p>
<p>Στον υπολογιστή, ανοίξτε <b>Ρυθμίσεις → Κινητά</b> και πατήστε <b>Σύνδεση κινητού</b>. Γράψτε εδώ τον κωδικό που εμφανίζεται.</p>
<p class="en">On the computer, open <b>Settings → Phones</b> and choose <b>Pair a phone</b>. Type the code it shows here.</p>
<form id="pair" autocomplete="off">
<label for="code">Κωδικός <span>· Code</span></label>
<input id="code" name="code" inputmode="text" autocorrect="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="ABCD-EFGH" required>
<label for="name">Όνομα κινητού <span>· Phone's name</span></label>
<input id="name" name="name" maxlength="60" required>
<button id="go" type="submit">Σύνδεση · Connect</button>
</form>
<div id="status" role="status" aria-live="polite"></div>`,
  "/_link/pair.js",
);

/**
 * The pairing page's script. Claims the code, then waits for the person at the desktop to confirm,
 * then opens the app. The device token arrives as an HttpOnly cookie, so this script never holds it
 * longer than the response it came in.
 */
export const PAIR_SCRIPT = `(() => {
  const form = document.getElementById("pair");
  const code = document.getElementById("code");
  const name = document.getElementById("name");
  const go = document.getElementById("go");
  const status = document.getElementById("status");
  const given = new URLSearchParams(location.search).get("code");
  if (given) code.value = given;
  const ua = navigator.userAgent;
  name.value = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : "Κινητό";
  const say = (el, en) => {
    status.replaceChildren();
    const a = document.createElement("p"); a.textContent = el;
    const b = document.createElement("p"); b.className = "en"; b.textContent = en;
    status.append(a, b);
  };
  const REASONS = {
    unknown: ["Ο κωδικός δεν ισχύει. Ζητήστε νέο κωδικό στον υπολογιστή.", "That code is not valid. Ask the computer for a new one."],
    offline: ["Ο υπολογιστής δεν είναι συνδεδεμένος τώρα.", "The computer is not connected right now."],
    refused: ["Η σύνδεση απορρίφθηκε στον υπολογιστή.", "The pairing was declined on the computer."],
    expired: ["Ο χρόνος έληξε. Ζητήστε νέο κωδικό στον υπολογιστή.", "Time ran out. Ask the computer for a new code."],
    limited: ["Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.", "Too many tries. Try again in a minute."],
  };
  const refused = (reason) => { say(...(REASONS[reason] || REASONS.unknown)); go.disabled = false; };
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" }).then((r) => r.json());
  async function wait(pairingId) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      let answer;
      try { answer = await post("/_link/pair/status", { pairingId }); } catch { continue; }
      if (answer.status === "pending") continue;
      if (answer.status === "confirmed") { say("Έτοιμο. Ανοίγει…", "Done. Opening…"); location.replace("/"); return; }
      return refused(answer.reason);
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    say("Μια στιγμή…", "One moment…");
    let answer;
    try { answer = await post("/_link/pair/claim", { code: code.value, deviceName: name.value }); }
    catch { return refused("offline"); }
    if (answer.status !== "pending") return refused(answer.reason);
    say("Επιβεβαιώστε στον υπολογιστή ότι αυτό είναι το κινητό σας: «" + name.value.trim() + "».", "Confirm on the computer that this is your phone: “" + name.value.trim() + "”.");
    wait(answer.pairingId);
  });
})();
`;

/** The desktop this phone is paired with is not connected. */
export const OFFLINE_PAGE = page(
  "ArkAgent: ο υπολογιστής δεν απαντά",
  `<h1>Ο υπολογιστής σας δεν είναι συνδεδεμένος</h1>
<p class="en">Your computer is not connected</p>
<p>Το κινητό είναι συνδεδεμένο με τον υπολογιστή σας, αλλά εκείνος δεν απαντά τώρα: μπορεί να είναι κλειστός, σε αναμονή ή χωρίς internet, ή το ArkAgent να μην τρέχει. Ανοίξτε τον και δοκιμάστε ξανά.</p>
<p class="en">This phone is paired with your computer, but the computer is not answering: it may be off, asleep or offline, or ArkAgent may not be running. Turn it on and try again.</p>
<p><a href="/">Δοκιμή ξανά · Try again</a></p>`,
);

/** The phone carries no device token the relay knows. */
export const NOT_PAIRED_PAGE = page(
  "ArkAgent: το κινητό δεν είναι συνδεδεμένο",
  `<h1>Αυτό το κινητό δεν είναι συνδεδεμένο</h1>
<p class="en">This phone is not paired</p>
<p>Το κινητό αφαιρέθηκε από τον υπολογιστή, ή δεν συνδέθηκε ποτέ. Συνδέστε το ξανά με νέο κωδικό.</p>
<p class="en">The phone was removed on the computer, or was never paired. Pair it again with a new code.</p>
<p><a href="/_link/pair">Σύνδεση · Pair</a></p>`,
);
