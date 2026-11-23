/**
 * Support cases (#149, milestone 2), an extension of the board.
 *
 * A case has:
 * - a number and a customer id;
 * - a channel (in the app or email: Amgad, 18 Nov, support is in-app, with email kept for what
 *   still arrives at support@) and a language (el, en);
 * - the customer's plan when it was opened (trial or paid), an urgency (urgent or normal), a status
 *   and an owner (a board account);
 * - an SLA due time from the plan and the urgency, in Athens business hours (business-hours.ts),
 *   worked out again when the urgency changes;
 * - optionally a GitHub issue it is linked to;
 * - internal notes, kept as written: a note is never changed or removed.
 *
 * Who may do what is in roles.ts: everyone signed in reads cases; read-only cannot change them.
 * Every case opened, changed or noted goes into the audit log; a note's text does not.
 */
import {
  type Context,
  CUSTOMER_ID,
  type Extension,
  redirect,
  respond,
} from "./board";
import {
  slaDue as businessDue,
  type Calendar,
  type Plan,
} from "./business-hours";
import { type Html, html } from "./html";
import { type Lang, t, when } from "./i18n";
import * as pages from "./pages";
import { can } from "./roles";
import type { CheckinExport } from "./sources";
import type { Sql } from "./sql";
import { customerRows, type TimelineEvent } from "./summary";

export const CHANNELS = ["in-app", "email"] as const;
export const LANGUAGES = ["el", "en"] as const;
export const PRIORITIES = ["urgent", "normal"] as const;
export const PLANS = ["trial", "paid"] as const;
export const STATUSES = ["new", "open", "waiting", "solved", "closed"] as const;

/**
 * The customer id of a case sent from an install that is not activated yet (Help & support before
 * activation, Amgad 23 Nov 2026): no BlackArk proof says whose install it is. Its plan shows as
 * "none". The cases table keeps "trial" underneath (its plan column takes only trial or paid, and a
 * running board's table is not rebuilt for this), which also gives it the normal answer time.
 */
export const UNVERIFIED_CUSTOMER = "unverified";

/** The plan a person sees: "none" for an unverified case still on its first plan. */
export function shownPlan(row: Pick<Case, "customer_id" | "plan">): string {
  return row.customer_id === UNVERIFIED_CUSTOMER && row.plan === "trial"
    ? "none"
    : row.plan;
}

export type Channel = (typeof CHANNELS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = (typeof STATUSES)[number];

const OPEN_STATUSES: readonly Status[] = ["new", "open", "waiting"];

export type Case = {
  number: number;
  customer_id: string;
  channel: Channel;
  language: "el" | "en";
  priority: Priority;
  plan: Plan;
  status: Status;
  subject: string;
  owner: string | null;
  github_issue: number | null;
  sla_due_at: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  source_ref: string | null;
};

export type Note = {
  id: number;
  case_number: number;
  at: string;
  author: string;
  body: string;
};

export type NewCase = {
  customerId: string;
  channel: Channel;
  language: "el" | "en";
  priority: Priority;
  plan: Plan;
  subject: string;
  owner?: string | null;
  githubIssue?: number | null;
  note?: string;
  /** Where an automatic case came from (`app:<nonce>`, `mail:<message id>`), so it is opened once. */
  sourceRef?: string;
};

function slaDue(
  createdAt: string,
  plan: Plan,
  priority: Priority,
  calendar: Calendar,
): string {
  return new Date(
    businessDue(Date.parse(createdAt), plan, priority, calendar),
  ).toISOString();
}

export async function openCase(
  sql: Sql,
  input: NewCase,
  by: string,
  now: number,
  calendar: Calendar = {},
): Promise<Case> {
  const at = new Date(now).toISOString();
  const result = await sql.run(
    `INSERT INTO cases (customer_id, channel, language, priority, plan, status, subject, owner, github_issue, sla_due_at, created_at, created_by, updated_at, source_ref)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.customerId,
    input.channel,
    input.language,
    input.priority,
    input.plan,
    input.subject,
    input.owner ?? null,
    input.githubIssue ?? null,
    slaDue(at, input.plan, input.priority, calendar),
    at,
    by,
    at,
    input.sourceRef ?? null,
  );
  const made = result.lastRowId;
  if (input.note?.trim()) await addNote(sql, made, by, input.note, now);
  return (await getCase(sql, made)) as Case;
}

export function findBySource(
  sql: Sql,
  sourceRef: string,
): Promise<Case | null> {
  return sql.first<Case>("SELECT * FROM cases WHERE source_ref = ?", sourceRef);
}

export function getCase(sql: Sql, number: number): Promise<Case | null> {
  return sql.first<Case>("SELECT * FROM cases WHERE number = ?", number);
}

export async function listCases(
  sql: Sql,
  filter: { openOnly?: boolean; customerId?: string },
): Promise<Case[]> {
  const rows = filter.customerId
    ? await sql.all<Case>(
        "SELECT * FROM cases WHERE customer_id = ? ORDER BY number DESC LIMIT 500",
        filter.customerId,
      )
    : await sql.all<Case>("SELECT * FROM cases ORDER BY number DESC LIMIT 500");
  return rows.filter(
    (row) => !filter.openOnly || OPEN_STATUSES.includes(row.status),
  );
}

export function notes(sql: Sql, number: number): Promise<Note[]> {
  return sql.all<Note>(
    "SELECT * FROM case_notes WHERE case_number = ? ORDER BY id",
    number,
  );
}

export async function addNote(
  sql: Sql,
  number: number,
  author: string,
  body: string,
  now: number,
) {
  const at = new Date(now).toISOString();
  await sql.batch([
    [
      "INSERT INTO case_notes (case_number, at, author, body) VALUES (?, ?, ?, ?)",
      number,
      at,
      author,
      body.slice(0, 8000),
    ],
    ["UPDATE cases SET updated_at = ? WHERE number = ?", at, number],
  ]);
}

export type CaseChange = {
  status?: Status;
  priority?: Priority;
  /** Set by a person, e.g. on an email case from a paying customer (mail carries no signed plan). */
  plan?: Plan;
  owner?: string | null;
  githubIssue?: number | null;
};

/** Applies the changes that differ, and says what changed ("status new→open"), for the audit log. */
export async function changeCase(
  sql: Sql,
  current: Case,
  change: CaseChange,
  now: number,
  calendar: Calendar = {},
): Promise<string[]> {
  const changed: string[] = [];
  const next = { ...current };
  if (change.status && change.status !== current.status) {
    changed.push(`status ${current.status}→${change.status}`);
    next.status = change.status;
  }
  if (change.priority && change.priority !== current.priority) {
    changed.push(`priority ${current.priority}→${change.priority}`);
    next.priority = change.priority;
  }
  if (change.plan && change.plan !== current.plan) {
    changed.push(`plan ${current.plan}→${change.plan}`);
    next.plan = change.plan;
  }
  if (next.priority !== current.priority || next.plan !== current.plan) {
    next.sla_due_at = slaDue(
      current.created_at,
      next.plan,
      next.priority,
      calendar,
    );
  }
  if (change.owner !== undefined && change.owner !== current.owner) {
    changed.push(`owner ${current.owner ?? "-"}→${change.owner ?? "-"}`);
    next.owner = change.owner;
  }
  if (
    change.githubIssue !== undefined &&
    change.githubIssue !== current.github_issue
  ) {
    changed.push(
      `github ${current.github_issue ?? "-"}→${change.githubIssue ?? "-"}`,
    );
    next.github_issue = change.githubIssue;
  }
  if (changed.length) {
    await sql.run(
      "UPDATE cases SET status = ?, priority = ?, plan = ?, owner = ?, github_issue = ?, sla_due_at = ?, updated_at = ? WHERE number = ?",
      next.status,
      next.priority,
      next.plan,
      next.owner,
      next.github_issue,
      next.sla_due_at,
      new Date(now).toISOString(),
      current.number,
    );
  }
  return changed;
}

export function overdue(row: Case, now: number): boolean {
  return OPEN_STATUSES.includes(row.status) && Date.parse(row.sla_due_at) < now;
}

/** Board accounts a case can be given to: active owners, admins and support. */
async function assignable(sql: Sql): Promise<string[]> {
  const rows = await sql.all<{ username: string }>(
    "SELECT username FROM accounts WHERE status = 'active' AND role IN ('owner', 'admin', 'support') ORDER BY username",
  );
  return rows.map((row) => row.username);
}

// ---- Pages -------------------------------------------------------------------------------------

const CHANNEL_NAMES: Record<Channel, string> = {
  "in-app": "In the app",
  email: "Email",
};
const LANGUAGE_NAMES: Record<string, string> = { el: "Greek", en: "English" };

function options<T extends string>(
  lang: Lang,
  values: readonly T[],
  selected: string,
  label: (value: T) => string,
) {
  return values.map(
    (value) =>
      html`<option value="${value}"${value === selected ? html` selected` : ""}>${t(lang, label(value))}</option>`,
  );
}

function githubLink(repo: string, issue: number | null): Html {
  return issue
    ? html`<a href="https://github.com/${repo}/issues/${issue}" rel="noreferrer">#${issue}</a>`
    : html`–`;
}

function dueCell(lang: Lang, row: Case, now: number): Html {
  return html`${when(lang, row.sla_due_at)}${overdue(row, now) ? html` <span class="tag bad">${t(lang, "overdue")}</span>` : ""}`;
}

function listPage(
  frame: pages.Frame,
  rows: Case[],
  openOnly: boolean,
  now: number,
  repo: string,
  canWrite: boolean,
) {
  const l = frame.lang;
  return pages.layout(
    frame,
    t(l, "Cases"),
    html`<p class="filters">${
      openOnly
        ? html`<strong>${t(l, "Only open")}</strong> <a href="/cases?status=all">${t(l, "All")}</a>`
        : html`<a href="/cases">${t(l, "Only open")}</a> <strong>${t(l, "All")}</strong>`
    }${canWrite ? html` · <a class="button" href="/cases/new">${t(l, "New case")}</a>` : ""}</p>
<div class="scroll"><table>
<thead><tr><th>#</th><th>${t(l, "Customer")}</th><th>${t(l, "Subject")}</th><th>${t(l, "Channel")}</th><th>${t(l, "Language")}</th><th>${t(l, "Priority")}</th><th>${t(l, "Status")}</th><th>${t(l, "Assigned to")}</th><th>${t(l, "Due by")}</th><th>${t(l, "GitHub issue")}</th></tr></thead>
<tbody>${
      rows.length === 0
        ? html`<tr><td colspan="10">${t(l, "No cases.")}</td></tr>`
        : rows.map(
            (row) =>
              html`<tr><td><a href="/cases/${row.number}">#${row.number}</a></td><td><a href="/customers/${encodeURIComponent(row.customer_id)}">${row.customer_id}</a></td><td>${row.subject}</td><td>${t(l, CHANNEL_NAMES[row.channel])}</td><td>${row.language}</td><td>${t(l, row.priority)}</td><td>${t(l, row.status)}</td><td>${row.owner ?? "–"}</td><td>${dueCell(l, row, now)}</td><td>${githubLink(repo, row.github_issue)}</td></tr>`,
          )
    }</tbody></table></div>`,
  );
}

function newCasePage(
  frame: pages.Frame,
  customer: string,
  owners: string[],
  error?: string,
) {
  const l = frame.lang;
  return pages.layout(
    frame,
    t(l, "New case"),
    html`${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<form method="post" action="/cases" class="stack">
  <input type="hidden" name="csrf" value="${frame.csrf ?? ""}">
  <label>${t(l, "Customer id")}<input name="customer" value="${customer}" required maxlength="80"></label>
  <label>${t(l, "Subject")}<input name="subject" required maxlength="200"></label>
  <label>${t(l, "Channel")}<select name="channel">${options(l, CHANNELS, "in-app", (value) => CHANNEL_NAMES[value])}</select></label>
  <label>${t(l, "Language")}<select name="language">${options(l, LANGUAGES, "el", (value) => LANGUAGE_NAMES[value] ?? value)}</select></label>
  <label>${t(l, "Priority")}<select name="priority">${options(l, PRIORITIES, "normal", (value) => value)}</select></label>
  <label>${t(l, "Assigned to")}<select name="owner"><option value="">${t(l, "Nobody yet")}</option>${owners.map((name) => html`<option value="${name}">${name}</option>`)}</select></label>
  <label>${t(l, "GitHub issue")}<input name="github" inputmode="numeric" pattern="[0-9]{0,7}" placeholder="${t(l, "Issue number, or empty")}"></label>
  <label>${t(l, "Internal notes")}<textarea name="note" rows="5" maxlength="8000"></textarea></label>
  <p class="muted">${t(l, "Notes are internal: the customer never sees them. Do not paste passwords, keys or a customer's personal data.")}</p>
  <button type="submit">${t(l, "Open the case")}</button>
</form>`,
  );
}

function casePage(
  frame: pages.Frame,
  row: Case,
  caseNotes: Note[],
  owners: string[],
  now: number,
  repo: string,
  canWrite: boolean,
  error?: string,
) {
  const l = frame.lang;
  const csrf = frame.csrf ?? "";
  return pages.layout(
    frame,
    `${t(l, "Case")} #${row.number}: ${row.subject}`,
    html`${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<dl class="facts">
<dt>${t(l, "Customer")}</dt><dd><a href="/customers/${encodeURIComponent(row.customer_id)}">${row.customer_id}</a></dd>
<dt>${t(l, "Channel")}</dt><dd>${t(l, CHANNEL_NAMES[row.channel])}</dd>
<dt>${t(l, "Language")}</dt><dd>${t(l, LANGUAGE_NAMES[row.language] ?? row.language)}</dd>
<dt>${t(l, "Plan")}</dt><dd>${t(l, shownPlan(row))}</dd>
<dt>${t(l, "Priority")}</dt><dd>${t(l, row.priority)}</dd>
<dt>${t(l, "Status")}</dt><dd>${t(l, row.status)}</dd>
<dt>${t(l, "Assigned to")}</dt><dd>${row.owner ?? t(l, "Nobody yet")}</dd>
<dt>${t(l, "Due by")}</dt><dd>${dueCell(l, row, now)}</dd>
<dt>${t(l, "GitHub issue")}</dt><dd>${githubLink(repo, row.github_issue)}</dd>
<dt>${t(l, "Opened")}</dt><dd>${when(l, row.created_at)} · ${row.created_by}</dd>
</dl>
${
  canWrite
    ? html`<form method="post" action="/cases/${row.number}" class="stack">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="update">
  <label>${t(l, "Status")}<select name="status">${options(l, STATUSES, row.status, (value) => value)}</select></label>
  <label>${t(l, "Priority")}<select name="priority">${options(l, PRIORITIES, row.priority, (value) => value)}</select></label>
  <label>${t(l, "Plan")}<select name="plan">${options(l, PLANS, row.plan, (value) => value)}</select></label>
  <label>${t(l, "Assigned to")}<select name="owner"><option value="">${t(l, "Nobody yet")}</option>${owners.map((name) => html`<option value="${name}"${name === row.owner ? html` selected` : ""}>${name}</option>`)}</select></label>
  <label>${t(l, "GitHub issue")}<input name="github" inputmode="numeric" pattern="[0-9]{0,7}" value="${row.github_issue ?? ""}" placeholder="${t(l, "Issue number, or empty")}"></label>
  <button type="submit">${t(l, "Save changes")}</button>
</form>`
    : html`<p class="muted">${t(l, "Your role can read cases but not change them.")}</p>`
}
<h2>${t(l, "Internal notes")}</h2>
<ol class="timeline">${
      caseNotes.length === 0
        ? html`<li>${t(l, "No notes yet.")}</li>`
        : caseNotes.map(
            (note) =>
              html`<li><time datetime="${note.at}">${when(l, note.at)}</time> <strong>${note.author}</strong><br>${note.body.split("\n").map((line, index) => html`${index ? html`<br>` : ""}${line}`)}</li>`,
          )
    }</ol>
${
  canWrite
    ? html`<form method="post" action="/cases/${row.number}" class="stack">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="note">
  <label>${t(l, "Add a note")}<textarea name="body" rows="4" maxlength="8000" required></textarea></label>
  <p class="muted">${t(l, "Notes are internal: the customer never sees them. Do not paste passwords, keys or a customer's personal data.")}</p>
  <button type="submit">${t(l, "Add a note")}</button>
</form>`
    : ""
}`,
  );
}

// ---- Reading a form ----------------------------------------------------------------------------

function pick<T extends string>(
  values: readonly T[],
  value: string | null,
): T | null {
  return values.includes(value as T) ? (value as T) : null;
}

function issueNumber(value: string | null): number | null | "bad" {
  const text = (value ?? "").trim().replace(/^#/, "");
  if (!text) return null;
  return /^\d{1,7}$/.test(text) ? Number(text) : "bad";
}

// ---- The extension -----------------------------------------------------------------------------

export function casesExtension(
  sql: Sql,
  options: { githubRepo?: string; calendar?: Calendar } = {},
): Extension {
  const repo = options.githubRepo ?? "amgadbarkat-ab/Ark-Agent";
  const calendar = options.calendar ?? {};
  return {
    async timeline(customerId): Promise<TimelineEvent[]> {
      return (await listCases(sql, { customerId })).map((row) => ({
        at: row.created_at,
        kind: "case",
        number: row.number,
        subject: row.subject,
        status: row.status,
      }));
    },

    async handle(context: Context) {
      const { url, frame, session, lang } = context;
      const method = context.request.method;
      const role = session.account.role;
      const path = url.pathname;
      if (path !== "/cases" && !path.startsWith("/cases/")) return null;
      if (!can(role, "cases.read")) return context.refuse();
      const canWrite = can(role, "cases.write");
      const form = context.form ?? new URLSearchParams();

      if (path === "/cases" && method === "GET") {
        const openOnly = url.searchParams.get("status") !== "all";
        await context.audit(
          "view",
          "cases",
          "ok",
          openOnly ? undefined : "all",
        );
        return respond(
          listPage(
            frame,
            await listCases(sql, { openOnly }),
            openOnly,
            context.now,
            repo,
            canWrite,
          ),
        );
      }

      if (path === "/cases/new" && method === "GET") {
        if (!canWrite) return context.refuse();
        const customer = url.searchParams.get("customer") ?? "";
        return respond(
          newCasePage(
            frame,
            CUSTOMER_ID.test(customer) ? customer : "",
            await assignable(sql),
          ),
        );
      }

      if (path === "/cases" && method === "POST") {
        if (!canWrite) return context.refuse();
        const customer = (form.get("customer") ?? "").trim();
        const subject = (form.get("subject") ?? "").trim().slice(0, 200);
        const channel = pick(CHANNELS, form.get("channel"));
        const language = pick(LANGUAGES, form.get("language"));
        const priority = pick(PRIORITIES, form.get("priority"));
        const owner = form.get("owner") || null;
        const github = issueNumber(form.get("github"));
        const owners = await assignable(sql);
        const fail = async (message: string) => {
          await context.audit(
            "case.create",
            customer || null,
            "refused",
            message,
          );
          return respond(
            newCasePage(
              frame,
              CUSTOMER_ID.test(customer) ? customer : "",
              owners,
              t(lang, message),
            ),
            400,
          );
        };
        if (!CUSTOMER_ID.test(customer))
          return fail("That customer id is not valid.");
        if (!subject) return fail("Give the case a subject.");
        if (
          !channel ||
          !language ||
          !priority ||
          github === "bad" ||
          (owner && !owners.includes(owner))
        ) {
          return respond("", 400);
        }
        // The plan when the case is opened, from the check-ins: paid sets the SLA for urgent cases.
        const data = await context.snapshot<CheckinExport>("checkins");
        const known = data.value
          ? customerRows(data.value, context.now).find(
              (one) => one.customerId === customer,
            )
          : undefined;
        const plan: Plan = known?.plan === "paid" ? "paid" : "trial";
        const made = await openCase(
          sql,
          {
            customerId: customer,
            channel,
            language,
            priority,
            plan,
            subject,
            owner,
            githubIssue: github,
            note: form.get("note") ?? "",
          },
          session.account.username,
          context.now,
          calendar,
        );
        await context.audit(
          "case.create",
          `case:${made.number}`,
          "ok",
          `customer ${customer}, ${plan}, ${priority}${github ? `, github #${github}` : ""}`,
        );
        return redirect(`/cases/${made.number}`);
      }

      const one = path.match(/^\/cases\/(\d{1,9})$/);
      if (!one) return null;
      const row = await getCase(sql, Number(one[1]));
      if (!row) return null;

      if (method === "GET") {
        await context.audit("view", `case:${row.number}`);
        return respond(
          casePage(
            frame,
            row,
            await notes(sql, row.number),
            await assignable(sql),
            context.now,
            repo,
            canWrite,
          ),
        );
      }

      if (!canWrite) return context.refuse();
      const action = form.get("action");
      if (action === "note") {
        const body = (form.get("body") ?? "").trim();
        if (!body) return respond("", 400);
        await addNote(
          sql,
          row.number,
          session.account.username,
          body,
          context.now,
        );
        await context.audit(
          "case.note",
          `case:${row.number}`,
          "ok",
          `${body.length} characters`,
        );
        return redirect(`/cases/${row.number}`);
      }
      if (action === "update") {
        const status = pick(STATUSES, form.get("status"));
        const priority = pick(PRIORITIES, form.get("priority"));
        const plan = form.has("plan")
          ? pick(PLANS, form.get("plan"))
          : row.plan;
        const owner = form.get("owner") || null;
        const github = issueNumber(form.get("github"));
        if (
          !status ||
          !priority ||
          !plan ||
          github === "bad" ||
          (owner && !(await assignable(sql)).includes(owner))
        ) {
          return respond("", 400);
        }
        const changed = await changeCase(
          sql,
          row,
          { status, priority, plan, owner, githubIssue: github },
          context.now,
          calendar,
        );
        if (changed.length)
          await context.audit(
            "case.update",
            `case:${row.number}`,
            "ok",
            changed.join(", "),
          );
        return redirect(`/cases/${row.number}`);
      }
      return respond("", 400);
    },
  };
}
