/**
 * Which account at the vendor a person just connected, asked once with the access token that came
 * with their grant (DT Lab, #83: "the Gmail page doesn't show which account is connected").
 *
 * BEST EFFORT AND NEVER IN THE WAY. A connection that works matters more than its label, so a vendor
 * that is slow, refuses, or answers something unexpected leaves the account unnamed and the
 * connection is recorded all the same. The token is used for this one read and never kept.
 */

/** Where each catalogue entry says who is signed in, and which field holds the address. */
const WHO_AM_I: Record<string, { url: string; fields: string[] }> = {
  "google-gmail": {
    url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    fields: ["emailAddress"],
  },
  "google-drive": {
    url: "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
    fields: ["user.emailAddress"],
  },
  "microsoft-365": {
    url: "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
    fields: ["mail", "userPrincipalName"],
  },
};

const TIMEOUT_MS = 5_000;
const LONGEST = 254;

function read(body: unknown, path: string): string | null {
  let value: unknown = body;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null) return null;
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // An address, or nothing: this is drawn on a page, and a vendor's odd answer is not worth drawing.
  if (!trimmed || trimmed.length > LONGEST || /[\s<>]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export async function connectedAccount(
  serverId: string,
  accessToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const who = WHO_AM_I[serverId];
  if (!who || !accessToken) return null;
  try {
    const response = await fetchImpl(who.url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    for (const field of who.fields) {
      const account = read(body, field);
      if (account) return account;
    }
    return null;
  } catch {
    return null;
  }
}
