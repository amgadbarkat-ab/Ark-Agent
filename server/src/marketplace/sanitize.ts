/**
 * What must not be published: secrets, and private data.
 *
 * A shared coworker is read by strangers, and it is written by someone who wrote it for themselves:
 * their instructions can contain the key they pasted in to test it, a customer's address, an internal
 * hostname. So publishing is refused until the text is clean. Refused, not quietly altered: a
 * publisher who is told "line 3 looks like an API key" fixes it and learns something; a publisher
 * whose key was silently masked publishes a coworker that no longer works and does not know why.
 *
 * Findings name the kind and where, never the matched text, so reading the refusal does not leak
 * what it found.
 */

export type FindingKind =
  | "api_key"
  | "private_key"
  | "token"
  | "password"
  | "credentials_in_url"
  | "email"
  | "phone"
  | "payment_card"
  | "iban"
  | "internal_address";

export type Finding = {
  kind: FindingKind;
  /** Which field it was in, for a person to find it. */
  field: string;
  /** 1-based line within that field. */
  line: number;
  /** In words, for the person publishing. */
  message: string;
};

/** What is always refused. A credential has no safe form in a public listing. */
const SECRET_KINDS: ReadonlySet<FindingKind> = new Set([
  "api_key",
  "private_key",
  "token",
  "password",
  "credentials_in_url",
]);

export function isSecret(kind: FindingKind): boolean {
  return SECRET_KINDS.has(kind);
}

const MESSAGES: Record<FindingKind, string> = {
  api_key: "looks like an API key",
  private_key: "looks like a private key",
  token: "looks like an access token",
  password: "looks like a password",
  credentials_in_url: "has a username and password inside a web address",
  email: "contains an email address",
  phone: "contains a phone number",
  payment_card: "contains a payment card number",
  iban: "contains a bank account number",
  internal_address: "names an internal address or computer",
};

const PATTERNS: Array<{ kind: FindingKind; pattern: RegExp }> = [
  // Well-known key shapes.
  { kind: "api_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { kind: "api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { kind: "api_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "api_key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: "api_key", pattern: /\b(?:pk|rk|sk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: "api_key", pattern: /\bgsk_[A-Za-z0-9]{20,}/ },
  { kind: "api_key", pattern: /\bcpk-[A-Za-z0-9_-]{16,}/ },
  { kind: "token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { kind: "token", pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { kind: "token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    kind: "token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  { kind: "token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Assignments: password: hunter2, api_key = abcd1234...
  {
    kind: "password",
    pattern: /\b(?:password|passwd|pwd)\b\s*[:=]\s*["']?[^\s"']{4,}/i,
  },
  {
    kind: "api_key",
    pattern:
      /\b(?:api[_-]?key|secret|token|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i,
  },
  {
    kind: "credentials_in_url",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  },
  // Private data.
  { kind: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  {
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/,
  },
  {
    kind: "internal_address",
    pattern:
      /\b(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|corp|lan|intranet)\b/i,
  },
];

/** A digit run that is a payment card number: 13 to 19 digits that pass the Luhn check. */
function cardNumbers(line: string): boolean {
  for (const run of line.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = run[0].replace(/[^\d]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** A phone number: an international prefix or enough digits in the usual groupings. */
function phoneNumbers(line: string): boolean {
  for (const run of line.matchAll(
    /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g,
  )) {
    const digits = run[0].replace(/[^\d]/g, "");
    // Short runs are dates, versions and quantities. A phone number is long, and shaped with
    // separators or a plus sign; a bare run of digits is more likely an id.
    const separated = /[\s.()+-]/.test(run[0]);
    if (digits.length >= 9 && digits.length <= 15 && separated) return true;
  }
  return false;
}

/** Everything wrong with these named pieces of text. Empty means it may be published. */
export function scan(fields: Record<string, string | undefined>): Finding[] {
  const findings: Finding[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      const seen = new Set<FindingKind>();
      const add = (kind: FindingKind) => {
        if (seen.has(kind)) return;
        seen.add(kind);
        findings.push({
          kind,
          field,
          line: index + 1,
          message: `${field}, line ${index + 1}, ${MESSAGES[kind]}.`,
        });
      };
      for (const { kind, pattern } of PATTERNS) {
        if (pattern.test(line)) add(kind);
      }
      if (cardNumbers(line)) add("payment_card");
      if (phoneNumbers(line)) add("phone");
    });
  }
  return findings;
}

export type Verdict =
  | { ok: true }
  | { ok: false; secrets: Finding[]; privateData: Finding[] };

/**
 * Whether text may be published. Secrets are never allowed. Private data is allowed only when the
 * publisher has said they checked it, because a business name that looks like an address is theirs to
 * judge and ours to flag.
 */
export function judge(
  fields: Record<string, string | undefined>,
  options: { confirmedNoPrivateData: boolean },
): Verdict {
  const findings = scan(fields);
  const secrets = findings.filter((f) => isSecret(f.kind));
  const privateData = findings.filter((f) => !isSecret(f.kind));
  if (secrets.length > 0) return { ok: false, secrets, privateData };
  if (privateData.length > 0 && !options.confirmedNoPrivateData) {
    return { ok: false, secrets, privateData };
  }
  return { ok: true };
}
