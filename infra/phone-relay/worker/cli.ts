/**
 * The Workers phone relay's lines, from COO's terminal. The lines live in the relay's directory
 * object (SQLite in a Durable Object, which wrangler cannot reach), so this makes the relay's admin
 * call, with the admin token from the environment (typed at a hidden prompt, never on the command
 * line or in a file):
 *
 *   read -rs PHONE_ADMIN_TOKEN && export PHONE_ADMIN_TOKEN     # the ADMIN_TOKEN Worker secret
 *   bun cli.ts add-line <name> <+twilio-number> [<+fallback>]  prints the line token ONCE
 *   bun cli.ts bill-line <name> <customer-id|none>             pays the line from that prepaid balance
 *   bun cli.ts remove-line <name>                               its install is let go and refused
 *   bun cli.ts lines
 *   bun cli.ts alerts                                           BlackArk's recent internal alerts
 *
 * The line token is made here and printed to the terminal (stderr) once; only its SHA-256 is sent.
 * `PHONE_RELAY_URL` defaults to https://blackark-phone.blackark.workers.dev.
 */
import {
  CUSTOMER_ID,
  E164,
  LINE_NAME,
  type Line,
  randomKey,
  sha256HexWeb,
} from "../core";

export type Io = { out(line: string): void; err(line: string): void };
export type CliOptions = {
  relayUrl: string;
  adminToken: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

const USE =
  "Use: add-line <name> <+number> [<+fallback>] | bill-line <name> <customer-id|none> | remove-line <name> | lines | alerts";

export async function runCli(
  args: string[],
  io: Io,
  options: CliOptions,
): Promise<number> {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const [command, name = "", third, fourth] = args;
  const fail = (text: string) => {
    io.err(text);
    return 1;
  };

  /** Says why on stderr; nothing was done. */
  const refused = (text: string): null => {
    io.err(text);
    return null;
  };

  async function admin(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown> | null> {
    if (!options.adminToken)
      return refused(
        "PHONE_ADMIN_TOKEN is not set: read -rs PHONE_ADMIN_TOKEN && export PHONE_ADMIN_TOKEN",
      );
    const response = await send(
      `${options.relayUrl.replace(/\/+$/, "")}/admin/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ).catch((error: unknown) =>
      refused(
        `The relay could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    if (!response) return null;
    if (
      response.status === 404 &&
      !response.headers.get("content-type")?.includes("json")
    )
      return refused(
        "The relay refused the admin token: check PHONE_ADMIN_TOKEN is the ADMIN_TOKEN secret.",
      );
    const answer = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      return refused(String(answer.error ?? `HTTP ${response.status}`));
    return answer;
  }

  switch (command) {
    case "add-line": {
      const number = third ?? "";
      const fallback = fourth;
      if (!LINE_NAME.test(name))
        return fail(
          "The name is 2-40 lower-case letters, digits or hyphens, e.g. demo-shop.",
        );
      if (!E164.test(number))
        return fail(
          "The number is the Twilio number in +E.164 form, e.g. +302101234567.",
        );
      if (fallback && !E164.test(fallback))
        return fail("The fallback is a number in +E.164 form.");
      const token = randomKey(32);
      const line: Line = {
        name,
        number,
        tokenSha256: await sha256HexWeb(token),
        ...(fallback ? { fallback } : {}),
      };
      if (!(await admin("add", { line }))) return 1;
      io.out(`Line ${name} on ${number} saved.`);
      io.err(
        "Line token (shown once; type it into the install's masked field, never into a chat):",
      );
      io.err(token);
      return 0;
    }
    case "bill-line": {
      const customer = third ?? "";
      if (!(customer === "none" || CUSTOMER_ID.test(customer)))
        return fail(
          "Give the ArkAgent customer id (lower-case letters, digits, hyphens), or none.",
        );
      if (!(await admin("bill", { name, customerId: customer }))) return 1;
      io.out(
        customer === "none"
          ? `Line ${name} is no longer billed.`
          : `Line ${name} is billed to ${customer}'s prepaid phone balance.`,
      );
      return 0;
    }
    case "remove-line":
      if (!(await admin("remove", { name }))) return 1;
      io.out(`Line ${name} removed. Its install can no longer connect.`);
      return 0;
    case "lines": {
      const answer = await admin("lines", {});
      if (!answer) return 1;
      for (const line of answer.lines as Line[])
        io.out(
          `${line.name}\t${line.number}\tfallback ${line.fallback ?? "(none)"}\t${line.customerId ? `billed to ${line.customerId}` : "not billed"}`,
        );
      return 0;
    }
    case "alerts": {
      const answer = await admin("alerts", {});
      if (!answer) return 1;
      const alerts = answer.alerts as {
        at: string;
        subject: string;
        outcome: string;
      }[];
      if (alerts.length === 0) io.out("No alerts.");
      for (const alert of alerts)
        io.out(`${alert.at}\t${alert.outcome}\t${alert.subject}`);
      return 0;
    }
    default:
      return fail(USE);
  }
}

if (import.meta.main) {
  const code = await runCli(
    process.argv.slice(2),
    { out: (line) => console.log(line), err: (line) => console.error(line) },
    {
      relayUrl:
        process.env.PHONE_RELAY_URL?.trim() ||
        "https://blackark-phone.blackark.workers.dev",
      adminToken: process.env.PHONE_ADMIN_TOKEN?.trim() ?? "",
    },
  );
  process.exit(code);
}
