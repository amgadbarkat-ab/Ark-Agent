/**
 * Recent warnings and errors, scrubbed, for Help & support's optional diagnostics (#149).
 *
 * WHAT IS KEPT. The server's own console warnings and errors, in memory only, the last 200 lines
 * of the last 24 hours. Each line is scrubbed WHEN IT IS CAUGHT, so nothing unscrubbed is ever held:
 * - a JSON log line keeps only its descriptive fields (type, level, route, method, status, code,
 *   error name) and drops every free-text value;
 * - any other line loses quoted text, email addresses, web addresses' paths and queries, IP
 *   addresses, phone numbers, ids, anything that looks like a key, token or code, `secret=…`
 *   values, and the user name inside a home folder path.
 * Never kept or sent: conversations, mail, files, keys, or anything a person wrote.
 */

const MAX_LINES = 200;
const MAX_LINE = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The JSON fields a diagnostic line may keep: what happened, never about whom or what was said. */
const KEPT_FIELDS = [
  "type",
  "level",
  "event",
  "route",
  "method",
  "status",
  "code",
  "name",
  "errorName",
  "durationMs",
];

const RULES: Array<[RegExp, string]> = [
  // Values of anything named like a secret.
  [
    /\b(password|passwd|secret|token|api[_-]?key|key|authorization|cookie|bearer)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
    "$1=[hidden]",
  ],
  // Quoted text can be anything a person wrote.
  [/"[^"]*"/g, '"[text]"'],
  [/'[^']*'/g, "'[text]'"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  // A web address keeps only where it went.
  [/\b(https?|wss?):\/\/([^/\s?#:]+)(:\d+)?[^\s]*/gi, "$1://$2"],
  [/\bARK1-[A-Za-z0-9_.-]+/g, "[code]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[token]"],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[id]",
  ],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\+?\d[\d ()-]{7,}\d/g, "[number]"],
  // Long runs of letters and digits: keys, hashes, tokens.
  [/\b[A-Za-z0-9_+/=-]{24,}\b/g, "[secret]"],
  // The user name inside a home folder.
  [/(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s]+/g, "$1[user]"],
];

function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES)
    out = out.replace(pattern, replacement);
  return out;
}

/** One log line, safe to show and send. */
export function scrubLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const key of KEPT_FIELDS) {
        const value = parsed[key];
        if (typeof value === "number" || typeof value === "boolean")
          kept[key] = value;
        else if (typeof value === "string" && /^[\w.:/@-]{1,80}$/.test(value))
          kept[key] = scrubText(value);
      }
      return JSON.stringify(kept).slice(0, MAX_LINE);
    } catch {
      // Not JSON after all: treat it as text.
    }
  }
  return scrubText(trimmed).slice(0, MAX_LINE);
}

export type LogLine = { at: number; level: "warn" | "error"; line: string };

export type RecentLogs = {
  /** Lines of the last 24 hours, oldest first, at most `limit`. */
  lines(now?: number, limit?: number): string[];
  record(level: LogLine["level"], parts: unknown[], at?: number): void;
};

function describe(part: unknown): string {
  if (part instanceof Error) return `${part.name}: ${part.message}`;
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

export function recentLogs(): RecentLogs {
  const kept: LogLine[] = [];
  return {
    record(level, parts, at = Date.now()) {
      const line = scrubLine(parts.map(describe).join(" "));
      if (!line) return;
      kept.push({ at, level, line });
      if (kept.length > MAX_LINES) kept.splice(0, kept.length - MAX_LINES);
    },
    lines(now = Date.now(), limit = 50) {
      return kept
        .filter((one) => now - one.at <= DAY_MS)
        .slice(-limit)
        .map(
          (one) => `${new Date(one.at).toISOString()} ${one.level} ${one.line}`,
        );
    },
  };
}

/** Starts keeping console warnings and errors (scrubbed). Returns the buffer. Call once. */
export function captureConsole(logs: RecentLogs = recentLogs()): RecentLogs {
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  console.error = (...parts: unknown[]) => {
    error(...parts);
    try {
      logs.record("error", parts);
    } catch {}
  };
  console.warn = (...parts: unknown[]) => {
    warn(...parts);
    try {
      logs.record("warn", parts);
    } catch {}
  };
  return logs;
}
