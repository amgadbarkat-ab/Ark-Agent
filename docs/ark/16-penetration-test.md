# Penetration test (internal), 2026-10-08

This is the test plan from [15-security-review.md](15-security-review.md) carried out, by engineering,
against the real application. The owner asked on 2026-10-08 that engineering do all the testing, so no
outside tester has been commissioned. **It is an internal test: the same team that wrote the code attacked
it.** It finds what we thought to try; it is not independent, and section "What this does not show" says
what it cannot reach.

The attacks are kept as an automated suite, so they run again on every change:

```sh
bun run test:security      # 66 checks, about 20 seconds; needs only the test PostgreSQL
```

It is also a job in CI (`.github/workflows/ci.yml`), so a pull request that opens a hole fails.

## How it was done

`server/tests/security/` starts the **real server process** (`server/src/index.ts`, every route wired as
in production, the production payment provider configured) and **the real conversation hub**, against a
database made for the run and dropped afterwards. It creates three people with real, correctly signed
session cookies: customer *alice*, customer *bob* (each with their own account on a paid plan, and one of
everything: coworker, conversation, file, model key, skill, routine, voice transcript, marketplace
listing), and an administrator. Then it attacks over HTTP and WebSocket, the way a browser or a script on
the internet would.

The route list is the running server's own (258 registered entries, 142 distinct method-and-path pairs,
plus the wildcard mounts for sign-in, the model gateway, the agent runtime and the voice routes), not a
list we wrote, so a route added tomorrow is attacked tomorrow.

Each attack was first tried by hand to see what happens, then written down as a check. **A check that
passes is worth something only if it fails when the hole is open**, so several were proved by removing the
fix and watching them fail (the request-shape guard and the body cap, for example).

## Results

### Found and fixed

| # | Finding | Severity | Fix | Held by |
| --- | --- | --- | --- | --- |
| P1 | **Our own API did not ask where a request came from.** The sign-in library checks the origin of its routes, but the application's (`/api/agents`, instructions, model connections, plan, account deletion, every administrator action) relied only on the session cookie being `SameSite=Lax`. A page on a sibling subdomain (same site, so Lax does not apply) or a browser that ignores SameSite could change a signed-in person's standing instructions, or add a model connection that sends their conversations to an address of the attacker's choosing. WebSocket handshakes, which carry the cookie into something that acts as the person while it is open, had the same gap. | Medium | `server/src/origin-guard.ts`: a write, or a socket handshake, that a browser says came from another origin is refused; a request that says nothing (a script, a service) is authenticated as before. Also applied to the stream proxy in `index.ts`, which the app's middleware does not reach. | "a request that comes from another website" (3 checks), `origin-guard.test.ts` (11) |
| P2 | **No limit on how much JSON a request could say.** A signed-in customer posting a 50 MB "coworker" had all of it read and parsed; the only ceiling was the platform's 128 MB. A few at once is an outage for everybody. | Medium | `server/src/body-limit.ts`: 4 MB for JSON; uploads and audio have their own limits; the model gateway and agent runtime (whole conversations) are bounded by a server-wide 64 MB. | "a request body larger than any screen sends is refused", the 5 MB webhook |
| P3 | **A name that points inside the deployment was not recognised.** The address check reads the text of an address, so `https://innocent.attacker.example/` passed it while its DNS record pointed at `10.x`, the cluster's services or the cloud metadata address. That is how a model "provider" or agent endpoint a customer types becomes a request from inside the network. | Medium on the hosted service (its network policy already refuses the private ranges, so this was caught a layer down), higher anywhere without one | The name is resolved at every hop, and every answer must be public (`createAgentFetch`, `isInternalAddress`). **Residual, said plainly:** it resolves and the fetch resolves again, so a name that answers differently the second time (DNS rebinding) is not caught here; the cluster's network policy is what stops that. | "an address inside the deployment is never dialled" (3), `agent-endpoint.test.ts` (+12) |
| P4 | **Carrier-grade NAT (`100.64.0.0/10`) and other special ranges were treated as public.** A typed `http://100.64.0.1/` was accepted as a model connection. Clouds and overlay networks (Tailscale, some Kubernetes pod ranges) put their own addressing there. | Low | Added to the internal ranges, with `0.0.0.0/8`, `192.0.0.0/24`, the benchmarking range, multicast and reserved space. | the model-connection check above |
| P5 | **Forty-odd routes answered a server error to a hostile id.** `%00` (a NUL byte, which Postgres refuses) or a non-UUID in a path went into a query unchecked: `GET /api/agents/%00`, `DELETE /api/models/connections/x`, and the same on channels, routines, skills, plugin servers. No leak, but each was an unhandled exception and a noisy log, and a free way to probe. | Low | `server/src/request-shape.ts` refuses NUL and absurdly long addresses once, in front of every route; model-connection ids are validated as UUIDs and answer "no such connection". | "no route answers with a server error to hostile ids, bodies and search text" (every route × 8 ids, 7 bodies, 5 queries) |
| P6 | **The sign-in library has four routes that print a token, and the app uses none of them.** `list-sessions` returns every session's raw token; three more return the provider's own access and refresh tokens. The session cookie is `HttpOnly` so that a script in the page cannot read it, and a route that prints the same token as JSON undoes that for any script that can call it. | Low | The four routes do not exist (`app.ts`). | "the sign-in library does not print a token…" |
| P7 | **The hub's REST API and runner socket were reachable from the internet.** Both are for this deployment's own server, which reaches them inside the cluster, and each needs a key (and they held under attack, below), but publishing them is attack surface for no use. | Low | The hub's ingress publishes only `/client/websocket`, the browser's socket (`hub.ingress.paths`). | chart render, and the hub checks below |

### Tried and held

Each of these was attacked and the defence held. The number is the checks that keep it so.

| What was tried | Result |
| --- | --- |
| **Every route, with no session** (all 142) | Every route except the seven written down as public answers 401; the seven are listed with the reason, and none answers a stranger anything private. A new public route fails the suite until it is listed. |
| **Every administrator route, as a customer** (24 under `/api/admin`, 7 more elsewhere) | 403, every one. Seven spellings of the path (trailing slash, `..`, percent-encoding, double slash, a query and fragment) and forged identity and method-override headers do not get past. |
| **One customer against another**: every route carrying an id, with the other customer's id; 27 well-formed attacks (edit, delete, report, install, set a model on, pause, read a transcript, use a connection, grant a folder, run as their coworker); 17 lists | Never an answer containing the other's data; 404 or 403 each time; the other customer's coworker, routine, channel, file and listing unchanged afterwards. |
| **Mass assignment**: owner, account, id, package and system flags in a create | Ignored; the coworker is the caller's and "public" means public to their own account only. |
| **Buying more than was paid for**: `internal`, `enterprise`, a path-ish plan name | Refused; plan unchanged. |
| **Cloud running, which is charged for** (added with Phase 4): a customer setting a price or settling a month; agreeing to prices that are not the ones in force; a limit of nothing, negative, fractional, text or ten thousand and one euro; a stray `tenantId` in the body; reading or changing another customer's switch, limit or bill; settling a month twice | 403 for the staff routes (and 401 with no session); 409 for forged prices; 400 for every bad limit and stray field; each customer sees only their own agreement and months, without the payment service's reference or our notes; a settled month stays settled. The money routes are asserted to be on the list the unauthenticated and administrator sweeps walk. |
| **Sessions**: a cookie not signed by this server (wrong signature, no signature, garbage, 10 KB, another person's token), an expired session, a person an administrator has just removed | 401 each; removal takes effect on the next request. |
| **The sign-in library's own routes**: change email to the administrator's, update-user, sign-up, password sign-in and reset, register a way to sign in as a company domain, delete-user, a callback sent to another website | All refused (email cannot change; no passwords exist; registering a provider is administrators only; callbacks are checked). |
| **Forged payment notices**: no signature, wrong secret, stale, future, altered body, empty or garbage header, thousands of signatures, a signature of zeros | 400 or 431, account unchanged. A correctly signed notice applies once, a replay is ignored, an older one never overwrites a newer state. Only the configured provider has a door. |
| **The checkout page** with script in every parameter | Repeats nothing it was given. |
| **Outbound fetches** (26 address spellings × agent test, model probe and model save, plus agent registration): metadata addresses, loopback, private ranges, decimal/hex/octal/short forms, IPv4-in-IPv6, userinfo, trailing dots, `file:`, `gopher:`, `ftp:`, `dict:` | Refused with a sentence, nothing dialled. (Plus P3 and P4 above.) |
| **Uploads**: HTML, SVG, JavaScript, XHTML; 2 MB text, 70 MB binary; a filename with CR/LF and `../` | Scripting types refused (415); oversize refused before it is read (413); a stored file is always served as a download with `nosniff`; a hostile name sets no header. |
| **Hostile input**: broken JSON, arrays, `null`, 100,000 nested brackets, NUL, a 10,000-digit number, `__proto__` | 400 each; nothing polluted; the server answers the next request. |
| **Other websites**: preflight, reads, writes and socket handshakes with a foreign `Origin` | No cross-origin permission anywhere; writes and handshakes refused (P1). |
| **Rate limits**: exports (5 an hour), reports to the marketplace, deletion without the typed address | The limit bites; a wrong confirmation removes nothing, every time. |
| **Credentials that are not a cookie**: the model gateway with a guess, a grant signed by another key, an expired grant, a session token used as a grant, and a good grant for somebody else's connection; the bot tool endpoint with a guess and a forged run; the routines endpoint; a vendor's callback with a forged state; the desktop's door | 401 or a refusal each time; the routines endpoint answers a guess byte-for-byte as it answers nobody. |
| **Shared coworkers**, after the reviewer approves one | Readable and reportable by others; installing it is refused; clone, import, export, download and duplicate do not exist or refuse; nobody's address or id is in the listing; the sharer's own coworker stays private. |
| **The files the server hands out**: eleven path-traversal spellings against the built app | No file outside the app is read; unknown pages are the app; an unknown API path is JSON, not the app's HTML. |
| **Browser protections** on every kind of answer (200, 401, 404, a webhook refusal); no `Server` or `X-Powered-By` | Present everywhere. |
| **No internals in an error**: stack frames, file paths, query text, connection strings | None, in 4 kinds of failure. |
| **The conversation hub**: its API with no key and 6 wrong spellings of the key; a browser socket with a missing, malformed, wrongly signed, expired or tampered token; a token for one conversation joining another, a path trick, another person's thread list; the runner socket with a guess, the wrong key, a browser's token | 401 at the handshake or "unauthorized" at the join, each time; the right key and the right token do work, so the refusals mean something. |
| **Secrets in the repository** | None committed (the only matches are the fake keys in the scanner's own tests); `.env` is ignored by git and by Docker. |

## What this does not show

Said plainly, because a green list invites more trust than it has earned:

- **Not independent.** We wrote the defences and the attacks; what none of us thought of is not here. An outside tester brings other habits. Whether that is needed before launch is the owner's decision.
- **The bots' computers.** Escape from the browser container, reaching the cluster network or the metadata address from inside one, files across bots. Needs the container runtime and a cluster; the network policy that is meant to hold this was rendered and checked for coherence, never attacked.
- **A live conversation.** The suite runs with no model and no bot computer attached, so what happens inside a run (a prompt-injection that steers a coworker into misusing a tool it was granted) is not tested. That is the largest remaining risk of the product itself and is partly a design question: what each coworker may do is decided by grants a person gives.
- **Real identity providers.** The administrator rule and account linking are tested in code, not against a real Entra or Google sign-in.
- **The Azure deployment as built.** Network policy enforcement, private networking, Key Vault access, ingress behaviour and the alerts need a real subscription.
- **The desktop app and mobile.**
- **Load and denial of service** beyond the size caps; **timing side channels**; **dependency exploitability** (32 advisories remain, the `undici` group chiefly; see 15, O4).
- **A content-security-policy** is still not set (15, O3): a cross-site-scripting bug, should one exist, would be less contained than it should be. None was found: every user-supplied field the app draws is rendered as text, and there is no `dangerouslySetInnerHTML` anywhere in it.

## Informational

- The sign-in library's `get-session` returns the session's raw token in JSON to a script on the page, which the desktop's organisation sign-in uses, so it stays. It is the reason a content-security-policy matters.
- Sessions last seven days and are revoked on removal of a person's access, not on a change of role; a role change takes effect on the next request (the role is read fresh).
- The origin guard trusts the origins listed in `TRUSTED_ORIGINS`, the public URL and the app URL. A deployment that serves the app from a different host than the API must list it, or its writes are refused (the same list the sign-in library already needed).

## Re-running it

```sh
bun run test:security                       # all of it
OPENBOT_SECURITY=1 bun test server/tests/security/security.test.ts -t "one customer against another"
```

Add an attack by adding a check to `server/tests/security/security.test.ts` (or the hub's); the
harness (`harness.ts`) gives you the three people, their cookies, one of everything for a customer
(`seedCustomer`), and a `call(as, method, path, options)` that never throws on a status.
