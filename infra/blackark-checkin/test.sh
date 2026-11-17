#!/usr/bin/env bash
# Tests the check-in receiver on PHP's built-in server, against a throwaway copy with a test key.
# Needs: php (8.x, pdo_sqlite, sodium), curl, bun (to sign a test profile). Nothing leaves this machine.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'kill "${server:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

cp -R "$here/checkin" "$work/checkin"
mkdir -p "$work/outbox"

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
  'public_base_url' => 'https://blackark.example/checkin',
  'buy_url' => 'https://blackark.example/checkin/buy/',
  'stripe_api_key' => 'rk_test_fake',
  'stripe_api_base' => 'http://127.0.0.1:18766/fakestripe',
  'stripe_buy' => ['plan' => 'price_team', 'phone' => 'price_phone', 'block' => 'price_block5h'],
  'relay_secret' => 'relay-secret-for-tests-0123456789abcdef',
  // On here only, to test it; written to a folder instead of sent.
  'phone_low_email' => true,
  'phone_low_email_reply_to' => 'general@blackark.example',
  'mail_outbox_dir' => __DIR__ . '/../outbox',
];
PHP

# A stand-in for Stripe's API on a second port: it keeps every request (path and body) and answers
# a checkout with a fake checkout page, an invoice with a fake invoice id.
mkdir -p "$work/fake"
cat > "$work/fake/router.php" <<'FAKE'
<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
file_put_contents(__DIR__ . '/sent.log', $path . ' ' . ($_SERVER['HTTP_AUTHORIZATION'] ?? '') . ' ' . file_get_contents('php://input') . "\n", FILE_APPEND);
header('Content-Type: application/json');
if ($path === '/fakestripe/v1/checkout/sessions') {
    echo json_encode(['id' => 'cs_test_fake', 'url' => 'https://checkout.stripe.com/c/pay/cs_test_fake']);
} elseif ($path === '/fakestripe/v1/invoiceitems') {
    echo json_encode(['id' => 'ii_test_1']);
} elseif (preg_match('#^/fakestripe/v1/invoices(/in_test_1/(finalize|pay))?$#', $path)) {
    echo json_encode(['id' => 'in_test_1']);
} else {
    http_response_code(404);
    echo '{}';
}
FAKE
php -S "127.0.0.1:18766" "$work/fake/router.php" >/dev/null 2>&1 & fake=$!
trap 'kill "${server:-0}" "${fake:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

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

# Prepaid phone balance (v0.1.47): the buy page, the credits from Stripe, the relay's charges, never
# below zero, and the automatic top-up.
buy="http://127.0.0.1:$port/checkin/buy/"
location() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$1"; }
last() { tail -n 1 "$work/fake/sent.log"; }
sent_count() { grep -c "^$1 " "$work/fake/sent.log" || true; }
expect "the buy page without a customer is refused" 400 "$buy"
first="$(location "$buy?customer=demo-phone&phone=1")"
[[ "$first" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] \
  && grep -q 'Bearer rk_test_fake' <(last) && grep -q 'mode=subscription' <(last) && grep -q 'client_reference_id=demo-phone' <(last) \
  && grep -q 'price%5D=price_team' <(last) && grep -q 'price%5D=price_phone' <(last) && grep -q 'price%5D=price_block5h' <(last) \
  && grep -q 'phone_blocks%5D=1' <(last) && grep -q 'custom_fields%5B0%5D%5Bkey%5D=autotopup' <(last) \
  && { pass=$((pass+1)); echo "ok   buying with the phone add-on opens one checkout: plan, add-on, first block, automatic top-up choice"; } || { fail=$((fail+1)); echo "FAIL buy page ($first): $(last)"; }
expect "a top-up for a customer with no phone add-on is refused" 404 "$buy?customer=nobody-here&topup=1"

phone="http://127.0.0.1:$port/checkin/phone/"
sign_relay() { php -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2], "relay-secret-for-tests-0123456789abcdef");' "$1" "$2"; }
relay_call() { # json -> body; signed like the relay: HMAC-SHA256 of "<time>.<body>" with relay_secret
  local t; t="$(date +%s)"
  curl -s -X POST -H "x-ark-time: $t" -H "x-ark-signature: $(sign_relay "$t" "$1")" --data "$1" "$phone"
}
field() { php -r '$d = json_decode($argv[1], true); echo is_array($d) ? json_encode($d[$argv[2]] ?? null) : "none";' "$1" "$2"; }
balance() { relay_call '{"action":"balance","customerId":"demo-phone"}'; }
expect "an unsigned balance request is refused" 403 -X POST --data '{"action":"balance","customerId":"demo-phone"}' "$phone"
[[ "$(field "$(balance)" state)" == '"empty"' && "$(field "$(balance)" rates)" == '{"incoming":78,"landline":88,"mobile":139}' ]] \
  && { pass=$((pass+1)); echo "ok   before payment the balance is empty, and the rates come with it"; } || { fail=$((fail+1)); echo "FAIL empty before payment: $(balance)"; }

paid='{"id":"evt_p1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_phone1","client_reference_id":"demo-phone","customer":"cus_2","subscription":"sub_2","payment_status":"paid","customer_details":{"email":"owner@shop.example","address":{"country":"GR"}},"metadata":{"kind":"subscription","phone_blocks":"1"},"custom_fields":[{"key":"autotopup","type":"dropdown","dropdown":{"value":"yes"}}]}}}'
send_event "$paid" >/dev/null; send_event "${paid/evt_p1/evt_p2}" >/dev/null
[[ "$(field "$(balance)" balanceMils)" == 23400 && "$(field "$(balance)" state)" == '"ok"' ]] \
  && { pass=$((pass+1)); echo "ok   a paid checkout credits one 5-hour block (EUR 23.40), once even if Stripe sends it twice"; } || { fail=$((fail+1)); echo "FAIL block credit: $(balance)"; }

call() { echo "{\"action\":\"charge\",\"customerId\":\"demo-phone\",\"callId\":\"CA$(printf '%032d' "$1")\",\"parts\":$2}"; }
got="$(relay_call "$(call 1 '[{"kind":"incoming","seconds":75},{"kind":"mobile","seconds":61}]')")"
relay_call "$(call 1 '[{"kind":"incoming","seconds":75},{"kind":"mobile","seconds":61}]')" >/dev/null
[[ "$(field "$got" balanceMils)" == 22966 && "$(field "$(balance)" balanceMils)" == 22966 ]] \
  && { pass=$((pass+1)); echo "ok   a call takes whole minutes at each part's rate (2 x 0.078 + 2 x 0.139), and only once"; } || { fail=$((fail+1)); echo "FAIL charge: $got / $(balance)"; }
bad="$(call 2 '[{"kind":"premium","seconds":60}]')"; t="$(date +%s)"
expect "a charge with an unknown kind is refused" 400 -X POST -H "x-ark-time: $t" -H "x-ark-signature: $(sign_relay "$t" "$bad")" --data "$bad" "$phone"

got="$(relay_call "$(call 3 '[{"kind":"incoming","seconds":11400}]')")"
[[ "$(field "$got" state)" == '"low"' && "$(field "$got" minutesLeftAtLeast)" == 58 ]] \
  && { pass=$((pass+1)); echo "ok   in the last hour the state is low, with the minutes left at the mobile rate"; } || { fail=$((fail+1)); echo "FAIL low: $got"; }
[[ "$(sent_count /fakestripe/v1/invoiceitems)" == 1 && "$(sent_count /fakestripe/v1/invoices)" == 1 && "$(sent_count /fakestripe/v1/invoices/in_test_1/pay)" == 1 ]] \
  && grep '^/fakestripe/v1/invoices ' "$work/fake/sent.log" | grep -q 'subscription=sub_2' \
  && grep '^/fakestripe/v1/invoices ' "$work/fake/sent.log" | grep -q 'kind%5D=phone_topup' \
  && grep '^/fakestripe/v1/invoiceitems ' "$work/fake/sent.log" | grep -q 'customer=cus_2&subscription=sub_2&price=price_block5h' \
  && { pass=$((pass+1)); echo "ok   automatic top-up (chosen at checkout): one invoice for one block on the saved card"; } || { fail=$((fail+1)); echo "FAIL auto top-up: $(cat "$work/fake/sent.log")"; }
eml="$work/outbox/demo-phone.eml"
decoded() { php -r '$m = file_get_contents($argv[1]); [$h, $b] = explode("\r\n\r\n", $m, 2); echo base64_decode($b);' "$1"; }
subject() { php -r '$m = file_get_contents($argv[1]); preg_match("/^Subject: =\\?UTF-8\\?B\\?([^?]+)\\?=/m", $m, $x); echo base64_decode($x[1] ?? "");' "$1"; }
[[ -f "$eml" ]] && grep -q '^To: owner@shop.example' "$eml" && grep -q '^Reply-To: general@blackark.example' "$eml" \
  && [[ "$(subject "$eml")" == "ArkAgent: απομένει λιγότερο από μία ώρα τηλεφωνίας / less than one hour of phone time left" ]] \
  && decoded "$eml" | head -1 | grep -q '^Αγαπητέ πελάτη,' && decoded "$eml" | grep -q '^Dear customer,' \
  && decoded "$eml" | grep -q 'περίπου 58 λεπτά' && decoded "$eml" | grep -q 'about 58 minutes' \
  && decoded "$eml" | grep -q '^https://blackark.example/checkin/buy/?topup=1&customer=demo-phone$' \
  && { pass=$((pass+1)); echo "ok   the last hour: one email, Greek first then English (GR), with Reply-To and the top-up link"; } || { fail=$((fail+1)); echo "FAIL low email: $(cat "$eml" 2>/dev/null | head -12)"; }
rm -f "$eml"
relay_call "$(call 4 '[{"kind":"incoming","seconds":60}]')" >/dev/null
[[ ! -f "$eml" ]] && { pass=$((pass+1)); echo "ok   and only once until the next top-up"; } || { fail=$((fail+1)); echo "FAIL second low email"; }
[[ "$(sent_count /fakestripe/v1/invoices)" == 1 ]] && { pass=$((pass+1)); echo "ok   and only once until it is paid"; } || { fail=$((fail+1)); echo "FAIL second auto top-up"; }
send_event '{"id":"evt_i1","type":"invoice.paid","data":{"object":{"id":"in_test_1","subscription":"sub_2","metadata":{"kind":"phone_topup","customer_id":"demo-phone","phone_blocks":"1"},"lines":{"data":[{"price":{"id":"price_block5h"},"quantity":1}]}}}}' >/dev/null
[[ "$(field "$(balance)" balanceMils)" == 31468 ]] && { pass=$((pass+1)); echo "ok   the paid top-up invoice credits one block"; } || { fail=$((fail+1)); echo "FAIL invoice credit: $(balance)"; }

got="$(relay_call "$(call 5 '[{"kind":"mobile","seconds":86400}]')")"
[[ "$(field "$got" balanceMils)" == 0 && "$(field "$got" state)" == '"empty"' ]] \
  && { pass=$((pass+1)); echo "ok   a charge past the balance stops at zero, never below (the rest is written off)"; } || { fail=$((fail+1)); echo "FAIL clamp: $got"; }
written="$(php -r '$db = new PDO("sqlite:" . $argv[1]); echo $db->query("SELECT mils, written_off_mils FROM phone_ledger WHERE ref LIKE \"call:%5:mobile\"")->fetch(PDO::FETCH_NUM) ? implode(" ", $db->query("SELECT mils, written_off_mils FROM phone_ledger WHERE ref LIKE \"call:%5:mobile\"")->fetch(PDO::FETCH_NUM)) : "none";' "$work/checkin/data/checkins.sqlite")"
[[ "$written" == "-31468 168692" ]] && { pass=$((pass+1)); echo "ok   the ledger records what was charged and what was written off"; } || { fail=$((fail+1)); echo "FAIL ledger: $written"; }

[[ "$(location "$buy?customer=demo-phone&topup=1")" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] \
  && grep -q 'mode=payment' <(last) && grep -q 'price%5D=price_block5h' <(last) && ! grep -q 'price_team' <(last) && grep -q 'kind%5D=phone_topup' <(last) && ! grep -q 'custom_fields' <(last) \
  && { pass=$((pass+1)); echo "ok   a top-up opens a one-off checkout for one 5-hour block"; } || { fail=$((fail+1)); echo "FAIL top-up page: $(last)"; }
pending='{"id":"evt_t1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_topup1","client_reference_id":"demo-phone","payment_status":"unpaid","metadata":{"kind":"phone_topup","phone_blocks":"1"}}}}'
settled='{"id":"evt_t2","type":"checkout.session.async_payment_succeeded","data":{"object":{"id":"cs_test_topup1","client_reference_id":"demo-phone","payment_status":"paid","metadata":{"kind":"phone_topup","phone_blocks":"1"}}}}'
send_event "$pending" >/dev/null
before="$(field "$(balance)" balanceMils)"
send_event "$settled" >/dev/null
[[ "$before" == 0 && "$(field "$(balance)" balanceMils)" == 23400 && "$(field "$(balance)" state)" == '"ok"' ]] \
  && { pass=$((pass+1)); echo "ok   a top-up credits only once paid"; } || { fail=$((fail+1)); echo "FAIL top-up credit: $before / $(balance)"; }
expect "the top-up thank-you page" 200 "$buy?done=1"
[[ "$(php -r 'define("ARK_CHECKIN", true); $c = (require $argv[1])["countries"]; echo ($c["CY"] ?? "-") . ($c["GR"] ?? "-") . ($c["AE"] ?? "-") . ($c["FR"] ?? "-");' "$work/checkin/phone-emails.php")" == "elelen-" ]] \
  && { pass=$((pass+1)); echo "ok   Cyprus and Greece get Greek then English, the GCC English only, any other country the English text"; } || { fail=$((fail+1)); echo "FAIL country map"; }

# A GCC customer: English only.
gulf='{"id":"evt_g1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_gulf1","client_reference_id":"demo-gulf","customer":"cus_3","subscription":"sub_3","payment_status":"paid","customer_details":{"email":"owner@gulf.example","address":{"country":"AE"}},"metadata":{"kind":"subscription","phone_blocks":"1"}}}}'
send_event "$gulf" >/dev/null
gulfcall="{\"action\":\"charge\",\"customerId\":\"demo-gulf\",\"callId\":\"CA$(printf '%032d' 31)\",\"parts\":[{\"kind\":\"incoming\",\"seconds\":11700}]}"
relay_call "$gulfcall" >/dev/null
eml="$work/outbox/demo-gulf.eml"
[[ "$(subject "$eml")" == "ArkAgent: less than one hour of phone time left" ]] && decoded "$eml" | head -1 | grep -q '^Dear customer,' && ! decoded "$eml" | grep -q 'Αγαπητέ' \
  && { pass=$((pass+1)); echo "ok   a GCC customer (AE) gets the English text only"; } || { fail=$((fail+1)); echo "FAIL GCC email: $(subject "$eml") / $(decoded "$eml" | head -3)"; }

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
