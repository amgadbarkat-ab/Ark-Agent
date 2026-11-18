/**
 * The board's pages, rendered on the server. Every value goes through `html`, which escapes it.
 * Words go through `t`, which gives the Greek when the page is in Greek.
 */
import type { Account } from "./accounts";
import type { AuditRow } from "./audit";
import { type Html, html } from "./html";
import { type Lang, money, t, when } from "./i18n";
import { can } from "./roles";
import type { Health, Install, WorkItem } from "./sources";
import type { Role } from "./store";
import type { BillingSnapshot, StripeSubscription } from "./stripe";
import type { CustomerRow, Overview, TimelineEvent } from "./summary";

export type Frame = {
  lang: Lang;
  path: string;
  account: Account | null;
  csrf: string | null;
  /** Whether support cases (milestone 2) are switched on, for the menu. */
  cases?: boolean;
};

function langSwitch(frame: Frame): Html {
  const other = frame.lang === "el" ? "en" : "el";
  const label = frame.lang === "el" ? "English" : "Ελληνικά";
  return html`<a class="lang" href="/lang?to=${other}&amp;back=${encodeURIComponent(frame.path)}" lang="${other}">${label}</a>`;
}

export function roleName(lang: Lang, role: Role | string): string {
  const names: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    support: "Support",
    "read-only": "Read-only",
  };
  return t(lang, names[role] ?? role);
}

function nav(frame: Frame): Html {
  const account = frame.account;
  if (!account) return html``;
  const links: Array<[string, string, boolean]> = [
    ["/", "Overview", true],
    ["/customers", "Customers", true],
    [
      "/cases",
      "Cases",
      frame.cases === true && can(account.role, "cases.read"),
    ],
    ["/billing", "Billing", true],
    ["/services", "Services", true],
    ["/issues", "Issues and fixes", true],
    ["/audit", "Audit log", can(account.role, "audit.read")],
    ["/accounts", "Accounts", can(account.role, "accounts.manage")],
  ];
  return html`<nav>${links
    .filter(([, , shown]) => shown)
    .map(([href, label]) => {
      const current =
        href === "/" ? frame.path === "/" : frame.path.startsWith(href);
      return html`<a href="${href}"${current ? html` aria-current="page"` : ""}>${t(frame.lang, label)}</a>`;
    })}</nav>
  <form method="post" action="/logout" class="signout">
    <input type="hidden" name="csrf" value="${frame.csrf ?? ""}">
    <span>${account.username} · ${roleName(frame.lang, account.role)}</span>
    <button type="submit">${t(frame.lang, "Sign out")}</button>
  </form>`;
}

export function layout(frame: Frame, title: string, body: Html): string {
  return `<!doctype html>${html`<html lang="${frame.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · ${t(frame.lang, "BlackArk Control Board")}</title>
<link rel="stylesheet" href="/board.css">
</head>
<body>
<header><strong>${t(frame.lang, "BlackArk Control Board")}</strong>${langSwitch(frame)}${nav(frame)}</header>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>`}`;
}

function notice(
  text: string | null | undefined,
  kind: "error" | "info" = "error",
): Html {
  return text
    ? html`<p class="${kind}" role="${kind === "error" ? "alert" : "status"}">${text}</p>`
    : html``;
}

/** The banner when a source failed and the page shows its last good answer, or nothing. */
export function staleBanner(
  lang: Lang,
  fetchedAt: number | null,
  error?: string,
): Html {
  if (!error) return html``;
  return fetchedAt
    ? html`<p class="error" role="alert">${t(lang, "Could not refresh. Showing data from {time}.", { time: when(lang, new Date(fetchedAt).toISOString()) })}</p>`
    : html`<p class="error" role="alert">${t(lang, "The check-in service could not be reached.")}</p>`;
}

// ---- Sign-in and setup -------------------------------------------------------------------------

export function loginPage(
  frame: Frame,
  preCsrf: string,
  error?: string,
): string {
  const l = frame.lang;
  return layout(
    frame,
    t(l, "Sign in"),
    html`${notice(error)}
<form method="post" action="/login" class="stack">
  <input type="hidden" name="csrf" value="${preCsrf}">
  <label>${t(l, "User name")}<input name="username" autocomplete="username" required maxlength="32"></label>
  <label>${t(l, "Password")}<input name="password" type="password" autocomplete="current-password" required></label>
  <label>${t(l, "Code from your authenticator app")}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
  <button type="submit">${t(l, "Sign in")}</button>
</form>`,
  );
}

export function setupPage(
  frame: Frame,
  preCsrf: string,
  username: string,
  secret: string,
  uri: string,
  error?: string,
): string {
  const l = frame.lang;
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;
  return layout(
    frame,
    t(l, "Set up your account"),
    html`${notice(error)}
<p>${t(l, "Account")}: <strong>${username}</strong></p>
<ol>
  <li>${t(l, "Add this key to your authenticator app (time-based, 6 digits, 30 seconds):")}<br><code class="secret">${grouped}</code><br><small><code>${uri}</code></small></li>
  <li>${t(l, "Choose a password of at least 12 characters, and type the code your app shows now.")}</li>
</ol>
<form method="post" class="stack">
  <input type="hidden" name="csrf" value="${preCsrf}">
  <label>${t(l, "Password")}<input name="password" type="password" autocomplete="new-password" minlength="12" required></label>
  <label>${t(l, "Password again")}<input name="repeat" type="password" autocomplete="new-password" minlength="12" required></label>
  <label>${t(l, "Code from your authenticator app")}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
  <button type="submit">${t(l, "Finish setup")}</button>
</form>`,
  );
}

export function messagePage(frame: Frame, title: string, text: string): string {
  return layout(frame, title, html`<p>${text}</p>`);
}

// ---- Overview ----------------------------------------------------------------------------------

export type ServiceRow = { name: string; health: Health };

function serviceState(lang: Lang, health: Health): Html {
  if (health.up === null)
    return html`<span class="tag muted">${t(lang, "Not connected")}</span>`;
  return health.up
    ? html`<span class="tag ok">${t(lang, "Up")}</span>`
    : html`<span class="tag bad">${t(lang, "Down")}</span>`;
}

export function overviewPage(
  frame: Frame,
  numbers: Overview | null,
  services: ServiceRow[],
  banner: Html,
  failedPayments: number | null = null,
): string {
  const l = frame.lang;
  const tile = (
    label: string,
    value: number | string,
    href?: string,
    warn = false,
  ) =>
    html`<div class="tile${warn ? " warn" : ""}"><span class="n">${value}</span>${href ? html`<a href="${href}">${t(l, label)}</a>` : html`<span>${t(l, label)}</span>`}</div>`;
  const n = numbers;
  return layout(
    frame,
    t(l, "Overview"),
    html`${banner}
<section class="tiles" aria-label="${t(l, "Customers")}">
  ${
    n
      ? [
          tile("Installs", n.installs, "/customers"),
          tile("Customers", n.customers, "/customers"),
          tile("On trial", n.trial, "/customers?plan=trial"),
          tile("Paid", n.paid, "/customers?plan=paid"),
          tile(
            "Trial ends within 7 days",
            n.endingSoon,
            "/customers?plan=ending",
            n.endingSoon > 0,
          ),
          tile(
            "Installs silent for 2 days",
            n.silentInstalls,
            "/customers?plan=silent",
            n.silentInstalls > 0,
          ),
          tile(
            "Phone balances low",
            n.phoneLow,
            "/customers?plan=phone-low",
            n.phoneLow > 0,
          ),
          failedPayments === null
            ? ""
            : tile(
                "Failed payments",
                failedPayments,
                "/billing",
                failedPayments > 0,
              ),
        ]
      : html`<p>${t(l, "No check-in data yet.")}</p>`
  }
</section>
<h2>${t(l, "Services")}</h2>
<ul class="services">${services.map(
      (row) => html`<li>${serviceState(l, row.health)} ${t(l, row.name)}</li>`,
    )}</ul>`,
  );
}

// ---- Customers ---------------------------------------------------------------------------------

function planLabel(lang: Lang, row: CustomerRow): Html {
  if (row.plan === "paid")
    return html`<span class="tag ok">${t(lang, "Paid")}${row.planName ? html` · ${row.planName}` : ""}${row.addons.length ? html` + ${row.addons.join(", ")}` : ""}</span>`;
  if (row.plan === "trial")
    return html`<span class="tag">${t(lang, "Trial")}</span>`;
  return html`<span class="tag muted">${t(lang, "Trial ended")}</span>`;
}

function phoneLabel(lang: Lang, row: CustomerRow): Html {
  if (!row.phone) return html`<span class="muted">–</span>`;
  const state =
    row.phone.state === "ok" ? "" : row.phone.state === "low" ? "Low" : "Empty";
  return html`${money(lang, row.phone.balanceMils)}${state ? html` <span class="tag ${row.phone.state === "empty" ? "bad" : "warn"}">${t(lang, state)}</span>` : ""}`;
}

export const CUSTOMER_FILTERS = [
  "trial",
  "paid",
  "ended",
  "ending",
  "silent",
  "phone-low",
] as const;

export function filterCustomers(
  rows: CustomerRow[],
  filter: string | null,
): CustomerRow[] {
  switch (filter) {
    case "trial":
    case "paid":
    case "ended":
      return rows.filter((row) => row.plan === filter);
    case "ending":
      return rows.filter(
        (row) =>
          row.plan === "trial" && row.daysLeft !== null && row.daysLeft <= 7,
      );
    case "silent":
      return rows.filter((row) => row.silentInstalls > 0);
    case "phone-low":
      return rows.filter((row) => row.phone && row.phone.state !== "ok");
    default:
      return rows;
  }
}

export function customersPage(
  frame: Frame,
  rows: CustomerRow[],
  filter: string | null,
  banner: Html,
): string {
  const l = frame.lang;
  const filters: Array<[string | null, string]> = [
    [null, "All"],
    ["trial", "On trial"],
    ["paid", "Paid"],
    ["ended", "Trial ended"],
    ["ending", "Ending within 7 days"],
    ["silent", "Silent for 2 days"],
    ["phone-low", "Phone balance low"],
  ];
  return layout(
    frame,
    t(l, "Customers"),
    html`${banner}
<p class="filters">${filters.map(([value, label]) =>
      value === filter
        ? html`<strong>${t(l, label)}</strong> `
        : html`<a href="/customers${value ? `?plan=${value}` : ""}">${t(l, label)}</a> `,
    )}</p>
<div class="scroll"><table>
<thead><tr><th>${t(l, "Customer")}</th><th>${t(l, "Installs")}</th><th>${t(l, "Version")}</th><th>${t(l, "Plan")}</th><th>${t(l, "Days left")}</th><th>${t(l, "Phone balance")}</th><th>${t(l, "Last seen")}</th></tr></thead>
<tbody>${
      rows.length === 0
        ? html`<tr><td colspan="7">${t(l, "No customers.")}</td></tr>`
        : rows.map(
            (row) => html`<tr>
<td><a href="/customers/${encodeURIComponent(row.customerId)}">${row.customerId}</a>${row.severalInstalls ? html` <span class="tag warn">${t(l, "several installs")}</span>` : ""}</td>
<td>${row.installs.length}${row.silentInstalls ? html` <span class="tag warn">${t(l, "{n} silent", { n: row.silentInstalls })}</span>` : ""}</td>
<td>${row.version ?? "–"}</td>
<td>${planLabel(l, row)}</td>
<td>${row.daysLeft ?? "–"}</td>
<td>${phoneLabel(l, row)}</td>
<td>${row.lastSeen ? when(l, row.lastSeen) : "–"}</td>
</tr>`,
          )
    }</tbody>
</table></div>`,
  );
}

// ---- One customer ------------------------------------------------------------------------------

function shortId(install: Install): string {
  return install.installId.slice(0, 8);
}

function statusWord(lang: Lang, status: string): string {
  return t(
    lang,
    status === "paid" ? "paid" : status === "ended" ? "ended" : "trial",
  );
}

function eventText(lang: Lang, event: TimelineEvent): Html {
  switch (event.kind) {
    case "first-checkin":
      return html`${t(lang, "First check-in from install {id}", { id: shortId(event.install) })} (v${event.install.version})`;
    case "last-checkin":
      return html`${t(lang, "Last check-in from install {id}", { id: shortId(event.install) })}: v${event.install.version}, ${statusWord(lang, event.install.status)}${event.install.status === "trial" ? html`, ${t(lang, "{n} days left", { n: event.install.daysLeft })}` : ""}${event.install.verified ? html`, ${t(lang, "verified")}` : html`, ${t(lang, "unverified")}`}`;
    case "trial-ends":
      return html`${t(lang, "Trial ends on install {id}", { id: shortId(event.install) })}`;
    case "licence": {
      const licence = event.licence;
      const status =
        licence.status === "active" ? t(lang, "active") : t(lang, "cancelled");
      return html`${t(lang, "Licence")}: ${licence.plan ?? "–"}${licence.seats ? html`, ${t(lang, "{n} seats", { n: licence.seats })}` : ""}${licence.addons.length ? html` + ${licence.addons.join(", ")}` : ""}, ${status}${licence.periodEnd ? html`, ${t(lang, "period ends {date}", { date: when(lang, licence.periodEnd) })}` : ""}`;
    }
    case "phone": {
      const entry = event.entry;
      if (entry.kind === "block")
        return html`${t(lang, "Phone: 5-hour block credited")} (${money(lang, entry.mils)})`;
      const kinds: Record<string, string> = {
        incoming: "incoming",
        landline: "put through to a landline",
        mobile: "put through to a mobile",
      };
      return html`${t(lang, "Phone call")}, ${t(lang, kinds[entry.kind] ?? entry.kind)}: ${t(lang, "{n} min", { n: entry.minutes })}, ${money(lang, -entry.mils)}${entry.writtenOffMils ? html` <span class="tag warn">${t(lang, "written off {amount}", { amount: money(lang, entry.writtenOffMils) })}</span>` : ""}`;
    }
    case "case":
      return html`<a href="/cases/${event.number}">${t(lang, "Case")} #${event.number}</a>: ${event.subject} (${t(lang, event.status)})`;
  }
}

export function customerPage(
  frame: Frame,
  customerId: string,
  row: CustomerRow | null,
  events: TimelineEvent[],
  banner: Html,
  canOpenCase: boolean,
): string {
  const l = frame.lang;
  const summary = row
    ? html`<dl class="facts">
<dt>${t(l, "Plan")}</dt><dd>${planLabel(l, row)}</dd>
<dt>${t(l, "Days left")}</dt><dd>${row.daysLeft ?? "–"}</dd>
<dt>${t(l, "Phone balance")}</dt><dd>${phoneLabel(l, row)}</dd>
<dt>${t(l, "Last seen")}</dt><dd>${row.lastSeen ? when(l, row.lastSeen) : "–"}</dd>
</dl>
<h2>${t(l, "Installs")}</h2>
<div class="scroll"><table>
<thead><tr><th>${t(l, "Install")}</th><th>${t(l, "Version")}</th><th>${t(l, "Status")}</th><th>${t(l, "Days left")}</th><th>${t(l, "Trial employees")}</th><th>${t(l, "Proof")}</th><th>${t(l, "First seen")}</th><th>${t(l, "Last seen")}</th><th>${t(l, "Check-ins")}</th></tr></thead>
<tbody>${row.installs.map(
        (install) =>
          html`<tr><td><code>${shortId(install)}</code></td><td>${install.version}</td><td>${statusWord(l, install.status)}</td><td>${install.daysLeft}</td><td>${install.employees ?? "–"}</td><td>${install.verified ? t(l, "verified") : t(l, "unverified")}</td><td>${when(l, install.firstSeen)}</td><td>${when(l, install.lastSeen)}</td><td>${install.checkins}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p>${t(l, "No check-in data for this customer.")}</p>`;
  return layout(
    frame,
    customerId,
    html`${banner}${summary}
${canOpenCase ? html`<p><a class="button" href="/cases/new?customer=${encodeURIComponent(customerId)}">${t(l, "Open a case")}</a></p>` : ""}
<h2>${t(l, "Timeline")}</h2>
<ol class="timeline">${
      events.length === 0
        ? html`<li>${t(l, "Nothing yet.")}</li>`
        : events.map(
            (event) =>
              html`<li><time datetime="${event.at}">${when(l, event.at)}</time> ${eventText(l, event)}</li>`,
          )
    }</ol>`,
  );
}

// ---- Services ----------------------------------------------------------------------------------

export function servicesPage(frame: Frame, services: ServiceRow[]): string {
  const l = frame.lang;
  return layout(
    frame,
    t(l, "Services"),
    html`<table>
<thead><tr><th>${t(l, "Service")}</th><th>${t(l, "State")}</th><th>${t(l, "Detail")}</th><th>${t(l, "Answered in")}</th></tr></thead>
<tbody>${services.map(
      (row) =>
        html`<tr><td>${t(l, row.name)}</td><td>${serviceState(l, row.health)}</td><td>${t(l, row.health.detail)}</td><td>${row.health.ms !== undefined ? `${row.health.ms} ms` : "–"}</td></tr>`,
    )}</tbody></table>
<p class="muted">${t(l, "Checked when this page opens, at most once a minute.")}</p>`,
  );
}

// ---- Issues and fixes --------------------------------------------------------------------------

export function issuesPage(
  frame: Frame,
  items: WorkItem[] | null,
  error?: string,
): string {
  const l = frame.lang;
  if (items === null) {
    return layout(
      frame,
      t(l, "Issues and fixes"),
      html`${notice(error)}<p>${t(l, "GitHub is not connected yet. It needs a read-only token, after Amgad's yes.")}</p>`,
    );
  }
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    for (const label of item.labels.length ? item.labels : ["(no label)"]) {
      groups.set(label, [...(groups.get(label) ?? []), item]);
    }
  }
  const states: Array<WorkItem["state"]> = ["open", "merged", "closed"];
  const labels = [...groups.keys()].sort((a, b) =>
    a === "(no label)" ? 1 : b === "(no label)" ? -1 : a.localeCompare(b),
  );
  return layout(
    frame,
    t(l, "Issues and fixes"),
    html`${notice(error)}
${labels.map((label) => {
  const inLabel = groups.get(label) ?? [];
  return html`<section class="group"><h2>${label === "(no label)" ? t(l, "No label") : label} <small>(${inLabel.length})</small></h2>
${states.map((state) => {
  const inState = inLabel.filter((item) => item.state === state);
  return inState.length
    ? html`<h3>${t(l, state === "open" ? "Open" : state === "merged" ? "Merged" : "Closed")}</h3><ul>${inState.map(
        (item) =>
          html`<li><a href="${item.url}" rel="noreferrer">#${item.number}</a> ${item.kind === "pr" ? html`<span class="tag">PR</span> ` : ""}${item.title} <small class="muted">${when(l, item.updatedAt)}</small></li>`,
      )}</ul>`
    : html``;
})}</section>`;
})}${items.length === 0 ? html`<p>${t(l, "No issues.")}</p>` : ""}`,
  );
}

// ---- Audit log ---------------------------------------------------------------------------------

export function auditPage(
  frame: Frame,
  rows: AuditRow[],
  page: number,
  pages: number,
  brokenAt: number | null,
): string {
  const l = frame.lang;
  return layout(
    frame,
    t(l, "Audit log"),
    html`${
      brokenAt === null
        ? html`<p class="info">${t(l, "The chain of entries is intact.")}</p>`
        : html`<p class="error" role="alert">${t(l, "Entry {n} does not follow from the one before: the log was changed outside the board.", { n: brokenAt })}</p>`
    }
<div class="scroll"><table>
<thead><tr><th>#</th><th>${t(l, "When")}</th><th>${t(l, "Who")}</th><th>${t(l, "Action")}</th><th>${t(l, "On")}</th><th>${t(l, "Result")}</th><th>${t(l, "Detail")}</th></tr></thead>
<tbody>${rows.map(
      (row) =>
        html`<tr${row.outcome === "refused" ? html` class="refused"` : ""}><td>${row.id}</td><td>${when(l, row.at)}</td><td>${row.actor ?? "–"}${row.role ? html` <small class="muted">${roleName(l, row.role)}</small>` : ""}</td><td><code>${row.action}</code></td><td>${row.target ?? ""}</td><td>${row.outcome === "ok" ? t(l, "ok") : t(l, "refused")}</td><td>${row.detail ?? ""}</td></tr>`,
    )}</tbody></table></div>
<p class="pager">${page > 1 ? html`<a href="/audit?page=${page - 1}">${t(l, "Newer")}</a> ` : ""}${t(l, "Page {n} of {m}", { n: page, m: Math.max(1, pages) })}${page < pages ? html` <a href="/audit?page=${page + 1}">${t(l, "Older")}</a>` : ""}</p>`,
  );
}

// ---- Accounts ----------------------------------------------------------------------------------

export function accountsPage(
  frame: Frame,
  accounts: Account[],
  manageable: Role[],
  canManageRow: (account: Account) => boolean,
  message?: { setupLink?: string; username?: string; error?: string },
): string {
  const l = frame.lang;
  const csrf = frame.csrf ?? "";
  const statusText: Record<string, string> = {
    pending: "Waiting for setup",
    active: "Active",
    disabled: "Disabled",
  };
  return layout(
    frame,
    t(l, "Accounts"),
    html`${notice(message?.error)}
${
  message?.setupLink
    ? html`<div class="info" role="status"><p>${t(l, "Setup link for {name}, valid for 24 hours. It is shown only now: give it to that person yourself, not by email or chat in the clear.", { name: message.username ?? "" })}</p><p><code class="secret">${message.setupLink}</code></p></div>`
    : ""
}
<div class="scroll"><table>
<thead><tr><th>${t(l, "User name")}</th><th>${t(l, "Role")}</th><th>${t(l, "Status")}</th><th>${t(l, "Added")}</th><th></th></tr></thead>
<tbody>${accounts.map(
      (account) =>
        html`<tr><td>${account.username}</td><td>${roleName(l, account.role)}</td><td>${t(l, statusText[account.status] ?? account.status)}</td><td>${when(l, account.created_at)}${account.created_by ? html` <small class="muted">${account.created_by}</small>` : ""}</td><td>${
          canManageRow(account)
            ? html`<form method="post" action="/accounts" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="username" value="${account.username}"><button name="action" value="reset">${t(l, "Reset password and 2FA")}</button>${account.status !== "disabled" ? html` <button name="action" value="disable">${t(l, "Disable")}</button>` : ""}</form>`
            : ""
        }</td></tr>`,
    )}</tbody></table></div>
<h2>${t(l, "Add an account")}</h2>
<form method="post" action="/accounts" class="stack">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="create">
  <label>${t(l, "User name")} <small class="muted">${t(l, "lower-case letters, digits, dot, dash")}</small><input name="username" required pattern="[a-z0-9][a-z0-9._\\-]{1,31}" maxlength="32"></label>
  <label>${t(l, "Role")}<select name="role">${manageable.map((role) => html`<option value="${role}">${roleName(l, role)}</option>`)}</select></label>
  <button type="submit">${t(l, "Add and make a setup link")}</button>
</form>`,
  );
}

// ---- Billing (Stripe, read-only) ---------------------------------------------------------------

function subscriptionState(lang: Lang, row: StripeSubscription): Html {
  const kind =
    row.status === "active" || row.status === "trialing"
      ? row.cancelAtPeriodEnd
        ? "warn"
        : "ok"
      : row.status === "past_due" ||
          row.status === "unpaid" ||
          row.status === "incomplete"
        ? "bad"
        : "muted";
  const word =
    row.cancelAtPeriodEnd && row.status === "active"
      ? "ends at period end"
      : row.status.replace(/_/g, " ");
  return html`<span class="tag ${kind}">${t(lang, word)}</span>`;
}

function customerLink(customerId: string): Html {
  return customerId.startsWith("stripe-")
    ? html`<code>${customerId}</code>`
    : html`<a href="/customers/${encodeURIComponent(customerId)}">${customerId}</a>`;
}

export function billingPage(
  frame: Frame,
  data: BillingSnapshot | null,
  error?: string,
): string {
  const l = frame.lang;
  if (data === null) {
    return layout(
      frame,
      t(l, "Billing"),
      html`${error ? html`<p class="error" role="alert">${error}</p>` : ""}<p>${t(l, "Stripe is not connected yet. It needs a restricted read-only key, made by COO.")}</p>`,
    );
  }
  const order = (row: StripeSubscription) =>
    row.status === "past_due" || row.status === "unpaid"
      ? 0
      : row.status === "active"
        ? 1
        : 2;
  const subscriptions = [...data.subscriptions].sort(
    (a, b) => order(a) - order(b) || a.customerId.localeCompare(b.customerId),
  );
  return layout(
    frame,
    t(l, "Billing"),
    html`${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<h2>${t(l, "Failed payments")} <small>(${data.failed.length})</small></h2>
${
  data.failed.length === 0
    ? html`<p>${t(l, "No failed payments.")}</p>`
    : html`<div class="scroll"><table>
<thead><tr><th>${t(l, "Customer")}</th><th>${t(l, "Amount due")}</th><th>${t(l, "Attempts")}</th><th>${t(l, "Next attempt")}</th><th>${t(l, "Since")}</th></tr></thead>
<tbody>${data.failed.map(
        (row) =>
          html`<tr><td>${customerLink(row.customerId)}</td><td>${money(l, row.amountDueCents * 10)}</td><td>${row.attempts}</td><td>${row.nextAttempt ? when(l, row.nextAttempt) : "–"}</td><td>${when(l, row.at)}</td></tr>`,
      )}</tbody></table></div>`
}
<h2>${t(l, "Subscriptions")} <small>(${subscriptions.length})</small></h2>
<div class="scroll"><table>
<thead><tr><th>${t(l, "Customer")}</th><th>${t(l, "State")}</th><th>${t(l, "Renews or ends")}</th><th>${t(l, "Amount")}</th></tr></thead>
<tbody>${subscriptions.map(
      (row) =>
        html`<tr><td>${customerLink(row.customerId)}</td><td>${subscriptionState(l, row)}</td><td>${row.currentPeriodEnd ? when(l, row.currentPeriodEnd) : "–"}</td><td>${money(l, row.amountCents * 10)}${row.interval ? html` / ${t(l, row.interval)}` : ""}</td></tr>`,
    )}</tbody></table></div>
<p class="muted">${t(l, "From Stripe with a read-only key, at most once a minute. No names, emails or cards are read.")}</p>`,
  );
}
