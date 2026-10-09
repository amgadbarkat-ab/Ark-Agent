# Capacity and load

What was measured, what it found, and what has not been measured. Numbers here come from one
development sandbox (a small virtual machine, the database on the same machine), so they say **where
time goes and what breaks**, not how many customers a pod holds. That has to be measured on the real
cluster (see the end).

## The tool

`bun scripts/load-profile.ts [agents] [channels] [skills]`, run from `server/`. It starts the real server
against a throwaway database (the security suite's harness), gives one customer a lot of everything
(default 40 coworkers, 150 conversations, 30 skills), then times every parameterless GET a screen makes,
25 times one after another and 20 at once. It finds the endpoint whose cost grows with what a customer
has, which is the one a bigger customer feels first.

## A finding that mattered more than any number: bursts could wedge the server

The first runs of the tool did not produce a table. **Twenty to thirty requests arriving together at a
freshly started server left some of them hanging for good, and then every later request hung too.** No
error, no timeout, `/health` still answering (it does not touch the database), so the platform's probes
would have passed and nobody would have restarted it.

- **Cause.** Bun 1.3.14's SQL pool loses queries when more are asked for at once than it has
  connections (ten by default) and the statements have not been prepared yet. The lost query never
  returns and the connection it was on is never freed. It reproduces without this application: one
  query, then three in parallel, thirty callers at once, a fresh pool, drizzle over Bun's SQL.
  `prepare: false`, a pool at least as large as the burst, or a pool of one each make it disappear;
  warm statements (the second burst) are fine.
- **Why nothing caught it.** Every test pins the pool to two connections and runs one thing at a time,
  and a deployment's first real burst is exactly when statements are cold. It also produced a
  second, quieter symptom: a request being handed another query's row (`row.agreementHistory is
  undefined`), seen once in the logs of the failing runs. That was the same fault, not a second one.
- **Fix.** The client is created with `prepare: false` (`server/src/db/client.ts`, comment there).
  Thirty, two hundred and five hundred requests at a cold pool all complete, on the real server for all
  27 parameterless GET endpoints at 30 and at 200 at once, and in `server/tests/db-burst.integration.test.ts`,
  which fails on the old client (it hangs) and runs with the ordinary suite.
- **What it costs.** Postgres parses each statement again instead of once per connection. Next to a
  network round trip for the statements this application sends, that is small; it was not measurable
  here. It also lets the database sit behind a connection pooler in transaction mode, which named
  statements cannot.
- **A rule that comes with it.** A statement sent unprepared tells the driver nothing about its
  parameters' types, so an object or a date that reaches a raw `sql` template has to be converted by the
  caller: `${JSON.stringify(value)}::jsonb`, `${date.toISOString()}::timestamptz`. Columns defined
  through drizzle already do (the `jsonb` in `db/schema/json.ts` stringifies). The two places that did
  not were found by the suite and fixed (`user-preferences.ts`, `auth/index.ts`); a new raw template with
  an object or a `Date` in it will fail its test the same way.
- **When to revisit.** When a newer Bun fixes the pool. The reproduction is in the regression test: put
  `prepare` back to its default and run it.

The hub uses `postgres.js`, not Bun's SQL, and is not affected: a cold burst of 400 conversations each
created, locked and connected at once was answered in full in 235 ms.

## Where a page load spends its time

One customer with 40 coworkers, 150 conversations and 30 skills; times in milliseconds, this sandbox.

| Route | Size | alone p50 | alone p95 | 20 at once p95 |
| --- | --- | --- | --- | --- |
| `/api/plugins` (skills, servers, catalogue) | 37 KB | 7.7 | 11.7 | 76 |
| `/api/agents` | 35 KB | 4.9 | 10.3 | 62 |
| `/api/channels` | 17 KB | 8.6 | 12.2 | 53 |
| `/api/account/cloud` | 0.4 KB | 8.9 | 11.4 | 83 |
| `/api/marketplace` | 3 KB | 4.1 | 7.9 | 51 |
| `/api/account` | 0.9 KB | 6.0 | 10.3 | 47 |
| `/api/routines` | 0.4 KB | 4.8 | 9.5 | 46 |
| `/api/me` | 0.2 KB | 2.8 | 7.4 | 24 |
| `/api/capabilities` | 0.2 KB | 1.5 | 5.2 | 16 |

Everything a screen asks for answers in under 10 ms alone and under 90 ms with twenty at once, for a
customer far larger than a typical one. Nothing is quadratic in what a customer owns; the two heaviest
(`/api/plugins`, `/api/agents`) are heavy because they return everything, 35 KB each at this size, and
are the first to look at if a customer with several hundred coworkers appears (page them).

`/api/me` (a session lookup and two small reads) on a warm server, fifty and two hundred at once, all
answered: a median of about 500 and 630 requests a second over five rounds, one process, this sandbox,
client and server competing for the same CPU. A ceiling for one process on this machine, not a forecast.

## The hub: one streaming reply, many watchers

A reply streamed a character at a time (2,000 pieces, the worst case for event count), with browsers
joined before it starts and each checking it received every character in order. One hub, then the
runner on one hub and the browsers on another (the scale-out case). This sandbox, one conversation.

| Watchers | Hubs | Events stored per second | Last watcher had the last event | Every watcher exact |
| --- | --- | --- | --- | --- |
| 50 | 1 | about 1,200 | 7 ms after the run ended | 50 of 50 |
| 200 | 1 | about 520 | 27 ms after | 200 of 200 |
| 100 | 2 (runner on one, browsers on the other) | about 660 | 33 ms after | 100 of 100 |

What it says: delivery is correct at 200 watchers and across two hubs, and the browsers are never
more than a few tens of milliseconds behind the run. What slows the run is fan-out, not storage: the
same 2,000 events take 1.7 s with 50 watchers and 3.8 s with 200, because each event is sent to every
socket. A person reading a reply streams perhaps 50 to 100 pieces a second, so one hub in this sandbox
could carry roughly ten to twenty such replies at once before pieces queue; a conversation with hundreds
of watchers is not a case this product has (a conversation is one person's, or a team's). Joining 200
browsers took 66 ms. Memory stayed around 250 MB for the test process including its own clients.

Not covered: hundreds of conversations at once (the database becomes the limit, and its cost is the
append per event), a long soak, and the hub's own database on another machine. The replay path was
measured separately: a 3,000-piece reply is replayed as one frame (10, replay compaction).

## What has not been measured

- **The real cluster.** Database latency over a private link instead of a local socket, pod CPU
  limits, the ingress, TLS. Every number above will be worse there, and the per-request cost will be
  dominated by round trips to the database, which is why the next two items matter.
- **How many customers a pod holds.** Needs the shape of real use (how many requests a person makes
  per minute, how many are on a long poll or socket) and a load test with it. `k6` against `dev` with
  the profile above as the script is the method; the metrics endpoint (`ark_http_request_duration_seconds`,
  `ark_http_requests_in_flight`) is how to read the result (13, "What to watch").
- **The hub with many conversations at once**, and the hub's database separate from the machine it
  runs on. The next section is one conversation with many watchers.
- **The work pool**: runs, the model calls they make, and the cost of a coworker's computer (17).
  This is the number that sets the price of the cloud add-on and has to come from the real cluster.
- **Long soaks**: memory over days, connection churn, a database failover under traffic.

When the first deployment to `dev` exists: run `scripts/load-profile.ts` against it (point the
harness at the deployment instead of a local process), then a burst test of the 27 routes at 200
at once on a freshly rolled pod, which is the case that failed here.
