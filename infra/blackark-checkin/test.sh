#!/usr/bin/env bash
# Tests the check-in receiver on PHP's built-in server, against a throwaway copy with a test key.
# Needs: php (8.x, pdo_sqlite, sodium), curl, bun (to sign a test profile). Nothing leaves this machine.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'kill "${server:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

cp -R "$here/checkin" "$work/checkin"

# A test key pair and a profile signed with it, made with ArkAgent's own signing code.
cat > "$work/sign.ts" <<'TS'
import { generateKeyPairSync } from "node:crypto";
import { encodeBase64Url } from "./shared/trial";
import { publicKeyToBase64, signText } from "./shared/trial-sign";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519").privateKey;
const encode = (id: string) => encodeBase64Url(JSON.stringify({ v: 1, customer: { id, name: id } }));
const wine = encode("demo-shop");
console.log(JSON.stringify({
  publicKey: publicKeyToBase64(publicKey),
  good: { profile: wine, signature: signText(privateKey, wine) },
  otherCustomer: { profile: encode("demo-clinic"), signature: signText(privateKey, encode("demo-clinic")) },
  wrongKey: { profile: wine, signature: signText(other, wine) },
}));
TS
cp "$work/sign.ts" "$repo/.checkin-sign.ts"
keys="$(cd "$repo" && bun .checkin-sign.ts)"; rm -f "$repo/.checkin-sign.ts"
json() { php -r '$d = json_decode($argv[1], true); echo json_encode($d[$argv[2]]);' "$keys" "$1"; }
public_key="$(php -r '$d = json_decode($argv[1], true); echo $d["publicKey"];' "$keys")"

hash="$(php -r 'echo password_hash("test-password", PASSWORD_DEFAULT);')"
# A throwaway licence key pair, as license-keygen would make (64-byte sodium secret, 32-byte public).
pair="$(php -r '$k = sodium_crypto_sign_keypair(); echo base64_encode(sodium_crypto_sign_secretkey($k)), " ", base64_encode(sodium_crypto_sign_publickey($k));')"
license_secret="${pair% *}"; license_public="${pair#* }"
cat > "$work/checkin/config.php" <<PHP
<?php
return [
  'admin_password_hash' => '$hash',
  'data_dir' => __DIR__ . '/data',
  'trial_public_keys' => ['$public_key'],
  'require_proof' => false,
  'rate_limit_seconds' => 300,
  'max_installs' => 2000,
  'license_secret_key' => '$license_secret',
  'license_public_key' => '$license_public',
  'license_grace_days' => 7,
  'license_renew_url' => 'https://blackark.example/checkin/renew/',
  'stripe_webhook_secret' => 'whsec_test',
  'stripe_prices' => ['price_team' => ['plan' => 'team', 'seats' => 1], 'price_phone' => ['addon' => 'phone']],
];
PHP

port=18765
php -S "127.0.0.1:$port" -t "$work" >/dev/null 2>&1 & server=$!
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$port/checkin/" -o /dev/null && break; sleep 0.1; done

pass=0; fail=0
expect() { # name, expected status, curl args...
  local name="$1" want="$2"; shift 2
  local got; got="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [[ "$got" == "$want" ]]; then pass=$((pass+1)); echo "ok   $name ($got)"; else fail=$((fail+1)); echo "FAIL $name: wanted $want, got $got"; fi
}
url="http://127.0.0.1:$port/checkin/"
post() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$1" "$url"; }
body='{"customerId":"demo-shop","installId":"6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b","version":"0.1.37","status":"trial","daysLeft":29,"endsAt":"2026-12-15T22:00:00.000Z","employees":12}'

expect "GET is refused" 405 "$url"
[[ "$(post "$body")" == 204 ]] && { pass=$((pass+1)); echo "ok   a v0.1.37 check-in is stored (204)"; } || { fail=$((fail+1)); echo "FAIL v0.1.37 check-in"; }
expect "the same install a moment later is rate-limited" 429 -X POST -H 'content-type: application/json' --data "$body" "$url"
expect "an unknown field is refused" 400 -X POST -H 'content-type: application/json' --data '{"customerId":"demo-shop","installId":"6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4c","version":"0.1.37","status":"trial","daysLeft":29,"note":"hi"}' "$url"
expect "a bad status is refused" 400 -X POST -H 'content-type: application/json' --data '{"customerId":"demo-shop","installId":"6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4d","version":"0.1.37","status":"free","daysLeft":29}' "$url"
expect "not JSON is refused" 400 -X POST --data 'hello' "$url"
good="$(json good)"; other="$(json otherCustomer)"; wrong="$(json wrongKey)"
proofed() { echo "{\"customerId\":\"demo-shop\",\"installId\":\"$1\",\"version\":\"0.1.38\",\"status\":\"trial\",\"daysLeft\":28,\"proof\":$2}"; }
expect "a signed profile for this customer is accepted" 204 -X POST -H 'content-type: application/json' --data "$(proofed 0a1b2c3d-0000-4000-8000-000000000001 "$good")" "$url"
expect "a profile signed for another customer is refused" 403 -X POST -H 'content-type: application/json' --data "$(proofed 0a1b2c3d-0000-4000-8000-000000000002 "$other")" "$url"
expect "a profile signed with another key is refused" 403 -X POST -H 'content-type: application/json' --data "$(proofed 0a1b2c3d-0000-4000-8000-000000000003 "$wrong")" "$url"
expect "the config file is not served" 404 "http://127.0.0.1:$port/checkin/lib.php"

# The status page: locked without a password, open with it, and flags the second demo-shop install.
jar="$work/jar"
page="$(curl -s -c "$jar" -b "$jar" "http://127.0.0.1:$port/checkin/admin/")"
grep -q 'name="password"' <<<"$page" && { pass=$((pass+1)); echo "ok   the status page asks for a password"; } || { fail=$((fail+1)); echo "FAIL no login form"; }
grep -q 'demo-shop' <<<"$page" && { fail=$((fail+1)); echo "FAIL data shown before sign-in"; } || { pass=$((pass+1)); echo "ok   nothing is shown before sign-in"; }
csrf="$(grep -o 'name="csrf" value="[0-9a-f]*"' <<<"$page" | head -1 | sed 's/.*value="//; s/"//')"
curl -s -c "$jar" -b "$jar" -o /dev/null --data "action=login&csrf=$csrf&password=wrong" "http://127.0.0.1:$port/checkin/admin/"
curl -s -c "$jar" -b "$jar" -o /dev/null --data "action=login&csrf=$csrf&password=test-password" "http://127.0.0.1:$port/checkin/admin/"
page="$(curl -s -c "$jar" -b "$jar" "http://127.0.0.1:$port/checkin/admin/")"
grep -q '0.1.37' <<<"$page" && grep -q 'verified' <<<"$page" && { pass=$((pass+1)); echo "ok   signed in: installs listed, verified shown"; } || { fail=$((fail+1)); echo "FAIL listing"; }
grep -q 'second install' <<<"$page" && { pass=$((pass+1)); echo "ok   a second install of demo-shop is flagged"; } || { fail=$((fail+1)); echo "FAIL second-install flag"; }

# Paid licence keys from Stripe (v0.1.44).
stripe="http://127.0.0.1:$port/checkin/stripe/"
send_event() { # json -> status; signed like Stripe: HMAC-SHA256 of "<t>.<body>" with the webhook secret
  local t; t="$(date +%s)"
  local sig; sig="$(php -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2], "whsec_test");' "$t" "$1")"
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "stripe-signature: t=$t,v1=$sig" -H 'content-type: application/json' --data "$1" "$stripe"
}
expect "a webhook without Stripe's signature is refused" 400 -X POST -H 'stripe-signature: t=1,v1=00' --data '{"id":"evt_x","type":"invoice.paid"}' "$stripe"
end=$(( $(date +%s) + 30*86400 ))
checkout='{"id":"evt_1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_abcdefghijkl","client_reference_id":"demo-shop","customer":"cus_1","subscription":"sub_1"}}}'
invoice='{"id":"evt_2","type":"invoice.paid","data":{"object":{"subscription":"sub_1","lines":{"data":[{"price":{"id":"price_team"},"quantity":1,"period":{"end":'"$end"'}},{"price":{"id":"price_phone"},"quantity":1,"period":{"end":'"$end"'}}]}}}}'
[[ "$(send_event "$invoice")" == 200 && "$(send_event "$checkout")" == 200 ]] && { pass=$((pass+1)); echo "ok   signed invoice and checkout events are taken, in either order"; } || { fail=$((fail+1)); echo "FAIL stripe events"; }
page="$(curl -s "http://127.0.0.1:$port/checkin/key/?session_id=cs_test_abcdefghijkl")"
key="$(grep -o 'ARK1-[A-Za-z0-9_.-]*' <<<"$page" | head -1)"
[[ -n "$key" ]] && { pass=$((pass+1)); echo "ok   the key page shows the key after payment"; } || { fail=$((fail+1)); echo "FAIL key page"; }
cat > "$repo/.checkin-verify.ts" <<'TS'
import { readActivationCode } from "./shared/activation";
import { publicKeyFromBase64, signedByAny } from "./shared/trial-sign";
const [key, pub, end] = process.argv.slice(2);
const read = readActivationCode(key);
const ok = signedByAny([publicKeyFromBase64(pub)], read.payload, read.signature);
const code = read.code as { action: string; customer: string; plan: string; addons?: string[]; validUntil: string; renewUrl?: string };
const graceOk = Date.parse(code.validUntil) === (Number(end) + 7 * 86400) * 1000;
console.log(ok && code.action === "license" && code.customer === "demo-shop" && code.plan === "team" && code.addons?.join() === "phone" && graceOk && code.renewUrl === "https://blackark.example/checkin/renew/" ? "valid" : `invalid ${JSON.stringify(code)} ${ok}`);
TS
verdict="$(cd "$repo" && bun .checkin-verify.ts "$key" "$license_public" "$end")"; rm -f "$repo/.checkin-verify.ts"
[[ "$verdict" == valid ]] && { pass=$((pass+1)); echo "ok   the app reads the key: signed, demo-shop, team, phone, period end + 7 days"; } || { fail=$((fail+1)); echo "FAIL key check: $verdict"; }
t="$(date +%s)"; sig="$(php -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2], "whsec_test");' "$t" "$invoice")"
again="$(curl -s -X POST -H "stripe-signature: t=$t,v1=$sig" --data "$invoice" "$stripe")"
grep -q 'Already taken' <<<"$again" && { pass=$((pass+1)); echo "ok   the same event twice is taken once"; } || { fail=$((fail+1)); echo "FAIL replay: $again"; }
renew="http://127.0.0.1:$port/checkin/renew/"
got="$(curl -s -X POST --data '{"customerId":"demo-shop","validUntil":"2026-01-01T00:00:00Z"}' "$renew")"
grep -q '"key":"ARK1-' <<<"$got" && { pass=$((pass+1)); echo "ok   renewal hands an older install the newer key"; } || { fail=$((fail+1)); echo "FAIL renew: $got"; }
got="$(curl -s -X POST --data '{"customerId":"demo-shop","validUntil":"2099-01-01T00:00:00Z"}' "$renew")"
[[ "$got" == '{}' ]] && { pass=$((pass+1)); echo "ok   and nothing to an install that is up to date"; } || { fail=$((fail+1)); echo "FAIL renew up to date: $got"; }
send_event '{"id":"evt_3","type":"customer.subscription.deleted","data":{"object":{"id":"sub_1"}}}' >/dev/null
got="$(curl -s -X POST --data '{"customerId":"demo-shop","validUntil":"2026-01-01T00:00:00Z"}' "$renew")"
[[ "$got" == '{}' ]] && { pass=$((pass+1)); echo "ok   a cancelled subscription gets no more keys"; } || { fail=$((fail+1)); echo "FAIL after cancel: $got"; }
page="$(curl -s "http://127.0.0.1:$port/checkin/key/?session_id=cs_unknownsession1")"
grep -q 'ετοιμάζεται' <<<"$page" && { pass=$((pass+1)); echo "ok   an unknown session sees 'being prepared', no key"; } || { fail=$((fail+1)); echo "FAIL unknown session"; }

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
