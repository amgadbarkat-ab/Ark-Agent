# BlackArk staff relay

Remote staff (Amgad, 25 Nov 2026; v0.1.56). A staff member away from the office reaches the company's
ArkAgent through this Cloudflare Worker.

## What it does, and what it cannot do

- The administrator's ArkAgent keeps one WebSocket open to the relay while **"Let my staff sign in
  from outside the office"** is on (Settings → Team).
- A staff computer opens one WebSocket per connection. The relay pairs it with one from the
  administrator's computer and moves bytes between the two.
- **Those bytes are a TLS connection** from the staff computer to the administrator's office
  listener. The staff computer checks the listener's certificate by the fingerprint in its join code
  before it sends anything, as on the office network. The relay holds no key and cannot read
  passwords, cookies, pages or chats.
- **Who may use it:**
  - **A host** needs a BlackArk licence key or trial activation code that is still valid. The
    signature is checked with BlackArk's public keys in `shared/license-public-key.ts`.
  - **An office id** belongs to the first host key that registers it, and the relay refuses any
    other host key afterwards.
  - **A staff computer** needs the access key, which only the join code carries. "Make a new join
    code" starts a new office with new keys.
- **What it keeps:** per office, the customer id and the SHA-256 of the host key and of the access
  key, in the office's Durable Object (SQLite). Nothing else. Logs are off (`observability`), and
  its own log lines say only "host connected" or "host disconnected".
- **Limits:**
  - 96 staff connections at once per office;
  - a connection the host doesn't take up within 15 seconds is closed;
  - at most 4 GB, or 12 hours, per connection;
  - 240 requests a minute per internet address, per relay instance;
  - at most 3 offices per licence.
- **What it keeps, and when it forgets:** nothing is stored for an office until a licensed host
  registers it. Switching remote staff off, or making a new join code, tells the relay to forget the
  office (`POST /v1/forget` with the host key).
- **Cutting a customer off** (a refund, a leaked key): add their customer id to `REVOKED_CUSTOMERS`
  in `wrangler.toml` and deploy. Their offices are refused and closed at once.

## Cost

Workers Paid ($5 a month for the whole account; Amgad approved this on 25 Nov, to switch on when
this is ready to deploy). Estimates are on #149 (comment of 25 Nov 08:05). An idle office costs
nothing: the host's keep-alive ping is answered by Cloudflare without waking the object
(hibernation).

## Deploy (COO)

1. **Check the address first.** The app connects to `blackark-staff.blackark.workers.dev`. Confirm
   that `blackark.workers.dev` is this Cloudflare account's own workers.dev subdomain: it is the
   one the phone relay (`blackark-phone.blackark.workers.dev`) runs on. If it is not, do not
   deploy: tell PE, and the address will move to one BlackArk owns.
2. Switch the Cloudflare account to **Workers Paid**.
3. From this directory, run `npx --yes wrangler@4.20.0 deploy`. There are no secrets to set.
4. Check that `https://blackark-staff.blackark.workers.dev/health` answers `ok`.

The app uses `wss://blackark-staff.blackark.workers.dev` unless `ARK_STAFF_RELAY_URL` says
otherwise. Until the relay is deployed, the switch in Settings shows "BlackArk's relay cannot be
reached from this computer". The office network is not affected.

## Tests

`bun test infra/staff-relay` runs the Worker and its object on Bun (`bun-runtime.ts`) with real
WebSockets. `server/tests/remote-staff.test.ts` joins a staff computer's relay and a company's
listener through it end to end. That includes an impostor behind the relay, which gets nothing.
