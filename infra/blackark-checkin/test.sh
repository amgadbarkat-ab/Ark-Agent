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
  'renew_per_install_per_hour' => 30,
  'stripe_webhook_secret' => 'whsec_test',
  'stripe_prices' => ['price_team' => ['plan' => 'team', 'seats' => 1, 'max_agents' => 5], 'price_tier10' => ['plan' => 'team', 'seats' => 1, 'max_agents' => 10], 'price_tier20' => ['plan' => 'team', 'seats' => 1, 'max_agents' => 20], 'price_phone' => ['addon' => 'phone']],
  'public_base_url' => 'https://blackark.example/checkin',
  'buy_url' => 'https://blackark.example/checkin/buy/',
  'stripe_api_key' => 'rk_test_fake',
  'stripe_meter_key' => 'rk_test_meter',
  'stripe_api_base' => 'http://127.0.0.1:18766/fakestripe',
  'stripe_buy' => ['tiers' => [5 => 'price_team', 10 => 'price_tier10', 20 => 'price_tier20'], 'phone' => 'price_phone', 'block' => 'price_block5h'],
  'relay_secret' => 'relay-secret-for-tests-0123456789abcdef',
  'export_secret' => 'export-secret-for-tests-0123456789abcdef',
  'intake_url' => 'http://127.0.0.1:18767/intake/app',
  'intake_secret' => 'intake-secret-for-tests-0123456789abcdef',
  'audit_copy_secret' => 'audit-copy-secret-for-tests-0123456789abcdef',
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
} elseif ($path === '/fakestripe/v1/billing/meter_events') {
    if (is_file(__DIR__ . '/meter_down')) {
        http_response_code(500);
        echo '{"error":{"message":"down"}}';
        exit;
    }
    echo json_encode(['object' => 'billing.meter_event']);
} elseif ($path === '/fakestripe/v1/prices') {
    // Ark Private Server's prices by lookup key, as COO made them; `price_drift` makes one differ.
    parse_str((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY), $q);
    $table = [
        'private_server_small_monthly' => ['price_srvSmallM', 950, 'recurring'],
        'private_server_gpu_entry_monthly' => ['price_srvGpuM', 35700, 'recurring'],
        'private_server_gpu_entry_activation' => ['price_srvGpuA', 34800, 'one_time'],
        'arkagent_support_247_monthly_eur' => ['price_sup247', 10000, 'recurring'],
    ];
    $data = [];
    foreach ((array) ($q['lookup_keys'] ?? []) as $key) {
        if (isset($table[$key])) {
            [$id, $amount, $type] = $table[$key];
            if (is_file(__DIR__ . '/price_drift') && $key === 'private_server_small_monthly') {
                $amount = 1050;
            }
            if (is_file(__DIR__ . '/support_drift') && $key === 'arkagent_support_247_monthly_eur') {
                $amount = 9000;
            }
            $data[] = ['id' => $id, 'lookup_key' => $key, 'active' => true, 'unit_amount' => $amount, 'currency' => 'eur', 'type' => $type, 'tax_behavior' => 'exclusive']
                + ($type === 'recurring' ? ['recurring' => ['interval' => 'month']] : []);
        }
    }
    echo json_encode(['object' => 'list', 'data' => $data]);
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
# A stand-in for the Control Board's /intake/app (#149): it checks the signature like the board,
# keeps what it was sent, and answers case 7 (or 503 when the subject asks it to be down).
mkdir -p "$work/board"
cat > "$work/board/router.php" <<'BOARD'
<?php
$body = file_get_contents('php://input');
$time = $_SERVER['HTTP_X_ARK_TIME'] ?? '';
$nonce = $_SERVER['HTTP_X_ARK_NONCE'] ?? '';
$want = hash_hmac('sha256', $time . '.' . $nonce . '.' . $body, 'intake-secret-for-tests-0123456789abcdef');
header('Content-Type: application/json');
if (!hash_equals($want, $_SERVER['HTTP_X_ARK_SIGNATURE'] ?? '') || abs(time() - (int) $time) > 300) {
    http_response_code(403);
    echo '{}';
    exit;
}
if (str_starts_with($_SERVER['REQUEST_URI'] ?? '', '/intake/order')) {
    // The orders stand-in: keeps each order message, one per line; `board_down` makes it unreachable.
    if (is_file(__DIR__ . '/board_down')) {
        http_response_code(503);
        echo '{}';
        exit;
    }
    file_put_contents(__DIR__ . '/orders.log', $body . "\n", FILE_APPEND);
    http_response_code(201);
    echo '{"case":31}';
    exit;
}
if (str_starts_with($_SERVER['REQUEST_URI'] ?? '', '/intake/replies')) {
    // The replies stand-in: one case with one reply for install …c1, and a field the app must not get.
    file_put_contents(__DIR__ . '/replies.json', $body);
    $asked = json_decode($body, true);
    echo json_encode(['cases' => ($asked['installId'] ?? '') === '1b2c3d4e-0000-4000-8000-0000000000c1' ? [[
        'case' => 9, 'subject' => 'Δεν ανοίγει', 'status' => 'waiting', 'openedAt' => '2026-11-24T10:00:00.000Z',
        'notes' => ['internal'],
        'replies' => [['at' => '2026-11-24T11:00:00.000Z', 'language' => 'el', 'text' => 'Δοκιμάστε ξανά.', 'english' => 'Please try again.', 'author' => 'maria']],
    ]] : []], JSON_UNESCAPED_UNICODE);
    exit;
}
file_put_contents(__DIR__ . '/received.json', $body);
if ((json_decode($body, true)['subject'] ?? '') === 'board-down') {
    http_response_code(503);
    echo '{}';
    exit;
}
http_response_code(201);
echo '{"case":7}';
BOARD
php -S "127.0.0.1:18767" "$work/board/router.php" >/dev/null 2>&1 & board_pid=$!
trap 'kill "${server:-0}" "${fake:-0}" "${board_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

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
# Renewal and activation after payment (v0.1.49): a key only to an install that proves who it is.
renew="http://127.0.0.1:$port/checkin/renew/"
ask_renew() { curl -s -o "$work/renew.out" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$1" "$renew"; }
renew_body() { # customer install validUntil-json proof-json
  echo "{\"customerId\":\"$1\",\"installId\":\"$2\",\"version\":\"0.1.49\",\"validUntil\":$3,\"proof\":$4}"
}
profile_proof() { php -r '$d = json_decode($argv[1], true); $d["kind"] = "profile"; echo json_encode($d);' "$1"; }
key_proof() { php -r '[$p, $s] = explode(".", substr($argv[1], 5)); echo json_encode(["kind" => "code", "payload" => $p, "signature" => $s]);' "$1"; }
key_nonce() { php -r '$p = explode(".", substr($argv[1], 5))[0]; echo json_decode(base64_decode(strtr($p, "-_", "+/")), true)["nonce"];' "$1"; }
r1=3c4d5e6f-0000-4000-8000-0000000000
expect "renewal without any proof is refused (a customer id is not enough)" 403 -X POST --data '{"customerId":"demo-shop","installId":"'"${r1}"'b1","validUntil":"2026-01-01T00:00:00Z"}' "$renew"
expect "renewal with no proof and no install id is refused the same way (403, not 400)" 403 -X POST --data '{"customerId":"demo-shop","validUntil":"2026-01-01T00:00:00Z"}' "$renew"
expect "a body that is not a request at all is still 400" 400 -X POST --data '{"customerId":"Not A Customer!"}' "$renew"
expect "renewal with a made-up key number is refused" 403 -X POST --data '{"customerId":"demo-shop","installId":"'"${r1}"'b1","validUntil":"2026-01-01T00:00:00Z","nonce":"not-a-real-nonce"}' "$renew"
got="$(ask_renew "$(renew_body demo-shop "${r1}b2" '"2026-01-01T00:00:00Z"' "$(key_proof "$key")")")"
[[ "$got" == 200 ]] && grep -q '"key":"ARK1-' "$work/renew.out" && { pass=$((pass+1)); echo "ok   renewal with the install's own licence key hands the newer key"; } || { fail=$((fail+1)); echo "FAIL renew with key: $got $(cat "$work/renew.out")"; }
got="$(ask_renew "$(renew_body demo-shop "${r1}b3" null "$(profile_proof "$good")")")"
[[ "$got" == 200 && "$(php -r 'echo json_decode(file_get_contents($argv[1]), true)["key"] ?? "";' "$work/renew.out")" == "$key" ]] \
  && { pass=$((pass+1)); echo "ok   a trial install (signed profile, no key yet) gets the key its customer paid for, unchanged"; } || { fail=$((fail+1)); echo "FAIL renew for trial: $got $(cat "$work/renew.out")"; }
trial_code="$(php -r 'echo rtrim(strtr(base64_encode(json_encode(["v" => 1, "action" => "trial", "customer" => "demo-shop", "nonce" => "t1", "issuedAt" => "2026-11-18T00:00:00Z", "plan" => "team", "until" => "2026-12-18T00:00:00Z"])), "+/", "-_"), "=");')"
forged_sig="$(php -r 'echo rtrim(strtr(base64_encode(random_bytes(64)), "+/", "-_"), "=");')"
expect "a trial code with a forged signature is refused" 403 -X POST --data "$(renew_body demo-shop "${r1}b4" null '{"kind":"code","payload":"'"$trial_code"'","signature":"'"$forged_sig"'"}')" "$renew"
expect "a profile signed for another customer is refused" 403 -X POST --data "$(renew_body demo-shop "${r1}b5" null "$(profile_proof "$other")")" "$renew"
expect "a profile signed with another key is refused" 403 -X POST --data "$(renew_body demo-shop "${r1}b5" null "$(profile_proof "$wrong")")" "$renew"
expect "proof for one customer does not fetch another customer's key" 403 -X POST --data "$(renew_body demo-clinic "${r1}b6" null "$(profile_proof "$good")")" "$renew"
got="$(ask_renew "$(renew_body demo-clinic "${r1}b7" null "$(profile_proof "$other")")")"
[[ "$got" == 200 && "$(cat "$work/renew.out")" == '{}' ]] && { pass=$((pass+1)); echo "ok   a customer who has not paid gets nothing"; } || { fail=$((fail+1)); echo "FAIL renew unpaid: $got $(cat "$work/renew.out")"; }
got="$(curl -s -X POST --data '{"customerId":"demo-shop","installId":"'"${r1}"'b8","version":"0.1.48","nonce":"'"$(key_nonce "$key")"'","validUntil":"2026-01-01T00:00:00Z"}' "$renew")"
grep -q '"key":"ARK1-' <<<"$got" && { pass=$((pass+1)); echo "ok   an install from v0.1.44 to v0.1.48 still renews: the number of a key issued to its customer is its proof"; } || { fail=$((fail+1)); echo "FAIL legacy renew: $got"; }
got="$(ask_renew "$(renew_body demo-shop "${r1}b9" '"2099-01-01T00:00:00Z"' "$(key_proof "$key")")")"
[[ "$(cat "$work/renew.out")" == '{}' ]] && { pass=$((pass+1)); echo "ok   and nothing to an install that is up to date"; } || { fail=$((fail+1)); echo "FAIL renew up to date: $got"; }
for _ in $(seq 1 30); do ask_renew "$(renew_body demo-shop "${r1}c1" null "$(profile_proof "$good")")" >/dev/null; done
expect "the 31st request from one install in an hour is refused" 429 -X POST --data "$(renew_body demo-shop "${r1}c1" null "$(profile_proof "$good")")" "$renew"
expect "and a request without proof from that install is refused the same way" 429 -X POST --data '{"customerId":"demo-shop","installId":"'"${r1}"'c1","validUntil":null}' "$renew"
send_event '{"id":"evt_3","type":"customer.subscription.deleted","data":{"object":{"id":"sub_1"}}}' >/dev/null
got="$(ask_renew "$(renew_body demo-shop "${r1}c2" '"2026-01-01T00:00:00Z"' "$(key_proof "$key")")")"
[[ "$(cat "$work/renew.out")" == '{}' ]] && { pass=$((pass+1)); echo "ok   a cancelled subscription gets no more keys"; } || { fail=$((fail+1)); echo "FAIL after cancel: $got"; }
page="$(curl -s "http://127.0.0.1:$port/checkin/key/?session_id=cs_unknownsession1")"
grep -q 'ετοιμάζεται' <<<"$page" && { pass=$((pass+1)); echo "ok   an unknown session sees 'being prepared', no key"; } || { fail=$((fail+1)); echo "FAIL unknown session"; }

# Prepaid phone balance (v0.1.47): the buy page, the credits from Stripe, the relay's charges, never
# below zero, and the automatic top-up.
buy="http://127.0.0.1:$port/checkin/buy/"
location() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$1"; }
last() { tail -n 1 "$work/fake/sent.log"; }
sent_count() { grep -c "^$1 " "$work/fake/sent.log" || true; }
expect "the buy page without a customer is refused" 400 "$buy"
first="$(location "$buy?customer=demo-phone&tier=5&phone=1")"
[[ "$first" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] \
  && grep -q 'Bearer rk_test_fake' <(last) && grep -q 'mode=subscription' <(last) && grep -q 'client_reference_id=demo-phone' <(last) \
  && grep -q 'price%5D=price_team' <(last) && grep -q 'price%5D=price_phone' <(last) && grep -q 'price%5D=price_block5h' <(last) \
  && grep -q 'phone_blocks%5D=1' <(last) && grep -q 'custom_fields%5B0%5D%5Bkey%5D=autotopup' <(last) \
  && { pass=$((pass+1)); echo "ok   buying with the phone add-on opens one checkout: plan, add-on, first block, automatic top-up choice"; } || { fail=$((fail+1)); echo "FAIL buy page ($first): $(last)"; }
expect "a top-up for a customer with no phone add-on is refused" 404 "$buy?customer=nobody-here&topup=1"

# One BlackArk look on every page a customer sees (Amgad, 19 Nov 2026): blackark.uk's colours, Geist,
# the company's tile and favicons, all served from checkin/brand/ and nothing from another site.
branded() { # name, url
  local page headers; page="$(curl -s "$2")"; headers="$(curl -s -D - -o /dev/null "$2")"
  if grep -q 'href="../brand/brand.css"' <<<"$page" && grep -q 'href="../brand/favicon.ico"' <<<"$page" \
    && grep -q '<rect width="160" height="160" rx="28" fill="#FF7A1A"/>' <<<"$page" \
    && ! grep -q 'system-ui,sans-serif;margin:0;padding:32px 16px;color:#1d1d1f' <<<"$page" \
    && ! grep -qE 'https?://[^"]*(fonts\.googleapis|fonts\.gstatic|cdn)' <<<"$page" \
    && grep -qi "content-security-policy: default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'" <<<"$headers"; then
    pass=$((pass+1)); echo "ok   $1 is in the BlackArk look"
  else fail=$((fail+1)); echo "FAIL $1 is not in the BlackArk look"; fi
}
branded "the tier page" "$buy?customer=demo-shop&phone=1"
branded "the top-up thank-you page" "$buy?done=1"
branded "the refusal page" "$buy?customer=demo-shop&tier=7"
branded "the licence key page" "http://127.0.0.1:$port/checkin/key/?session_id=cs_test_not_paid_yet"
grep -q 'class="choices"' <(curl -s "$buy?customer=demo-shop") && grep -q '<span class="price">€140</span>' <(curl -s "$buy?customer=demo-shop") \
  && { pass=$((pass+1)); echo "ok   the tiers are cards with their price in Geist Mono"; } || { fail=$((fail+1)); echo "FAIL tier cards"; }
for asset in brand.css geist.woff2 geist-mono.woff2 favicon.ico favicon-32.png favicon-192.png apple-touch-icon.png; do
  expect "brand/$asset is served" 200 "http://127.0.0.1:$port/checkin/brand/$asset"
done
cmp -s "$here/checkin/brand/geist.woff2" "$repo/brand/fonts/Geist-Variable.woff2" && cmp -s "$here/checkin/brand/favicon.ico" "$repo/brand/official/favicon.ico" \
  && { pass=$((pass+1)); echo "ok   the fonts and icons are the company's own files, unchanged"; } || { fail=$((fail+1)); echo "FAIL brand files drifted from brand/"; }

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
# One part of the multipart email (text/plain or text/html), decoded.
part() { php -r '$m = file_get_contents($argv[1]); foreach (preg_split("/\r\n--ark-[0-9a-f]+(--)?\r\n/", $m) as $p) { if (str_contains($p, "Content-Type: " . $argv[2] . ";")) { echo base64_decode(explode("\r\n\r\n", $p, 2)[1]); } }' "$1" "$2"; }
decoded() { part "$1" text/plain; }
subject() { php -r '$m = file_get_contents($argv[1]); preg_match("/^Subject: =\\?UTF-8\\?B\\?([^?]+)\\?=/m", $m, $x); echo base64_decode($x[1] ?? "");' "$1"; }
[[ -f "$eml" ]] && grep -q '^To: owner@shop.example' "$eml" && grep -q '^Reply-To: general@blackark.example' "$eml" \
  && [[ "$(subject "$eml")" == "ArkAgent: απομένει λιγότερο από μία ώρα τηλεφωνίας / less than one hour of phone time left" ]] \
  && decoded "$eml" | head -1 | grep -q '^Αγαπητέ πελάτη,' && decoded "$eml" | grep -q '^Dear customer,' \
  && decoded "$eml" | grep -q 'περίπου 58 λεπτά' && decoded "$eml" | grep -q 'about 58 minutes' \
  && decoded "$eml" | grep -q '^https://blackark.example/checkin/buy/?topup=1&customer=demo-phone$' \
  && { pass=$((pass+1)); echo "ok   the last hour: one email, Greek first then English (GR), with Reply-To and the top-up link"; } || { fail=$((fail+1)); echo "FAIL low email: $(cat "$eml" 2>/dev/null | head -12)"; }
# The same words in BlackArk's look (Amgad, 23 Nov): HTML beside the plain text, nothing added but the
# company's tile and name, the Greek marked Greek and the English below it marked English.
html="$(part "$eml" text/html)"
grep -q '^Content-Type: multipart/alternative; boundary="ark-[0-9a-f]*"' "$eml" \
  && grep -q 'background:#070504' <<<"$html" && grep -q 'favicon-192.png' <<<"$html" && grep -q '>BlackArk</td>' <<<"$html" \
  && grep -q '<div lang="el"><p style="margin:0 0 16px;">Αγαπητέ πελάτη,</p>' <<<"$html" && grep -q '<div lang="en"><p style="margin:0 0 16px;">Dear customer,</p>' <<<"$html" \
  && grep -q 'περίπου 58 λεπτά' <<<"$html" && grep -q 'about 58 minutes' <<<"$html" \
  && grep -q '<a href="https://blackark.example/checkin/buy/?topup=1&amp;customer=demo-phone"' <<<"$html" \
  && ! grep -qiE '<script|<svg|https?://(fonts\.|cdn)' <<<"$html" \
  && { pass=$((pass+1)); echo "ok   the email also comes in BlackArk's look: the same words, Greek then English, the top-up as a link"; } || { fail=$((fail+1)); echo "FAIL html email: $(head -c 600 <<<"$html")"; }
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

# The Control Board's read-only export (#149): signed both ways, each request taken once, nothing
# personal in it.
export_url="http://127.0.0.1:$port/checkin/export/"
export_secret='export-secret-for-tests-0123456789abcdef'
sign_export() { php -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2] . "." . $argv[3], $argv[4]);' "$1" "$2" "$3" "$export_secret"; }
want='{"want":"export"}'
export_call() { # time nonce signature -> headers in $work/export.h, body in $work/export.b; prints the status
  curl -s -D "$work/export.h" -o "$work/export.b" -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -H "x-ark-time: $1" -H "x-ark-nonce: $2" -H "x-ark-signature: $3" --data "$want" "$export_url"
}
expect "the export refuses GET" 405 "$export_url"
expect "the export refuses an unsigned request" 403 -X POST --data "$want" "$export_url"
t="$(date +%s)"; n="nonce-$(php -r 'echo bin2hex(random_bytes(8));')"
[[ "$(export_call "$t" "$n" "$(sign_export "$t" "$n" '{"want":"other"}')")" == 403 ]] \
  && { pass=$((pass+1)); echo "ok   the export refuses a signature over another body"; } || { fail=$((fail+1)); echo "FAIL export bad signature"; }
[[ "$(export_call "$t" "$n" "$(php -r 'echo hash_hmac("sha256", $argv[1], "not-the-export-secret-0123456789abcdef");' "$t.$n.$want")")" == 403 ]] \
  && { pass=$((pass+1)); echo "ok   the export refuses a request signed with another secret"; } || { fail=$((fail+1)); echo "FAIL export wrong secret"; }
old=$(( $(date +%s) - 600 ))
[[ "$(export_call "$old" "$n" "$(sign_export "$old" "$n" "$want")")" == 403 ]] \
  && { pass=$((pass+1)); echo "ok   the export refuses a signed request 10 minutes old"; } || { fail=$((fail+1)); echo "FAIL export stale"; }
got="$(export_call "$t" "$n" "$(sign_export "$t" "$n" "$want")")"
answered_at="$(grep -i '^x-ark-time:' "$work/export.h" | tr -d '\r' | awk '{print $2}')"
answer_sig="$(grep -i '^x-ark-signature:' "$work/export.h" | tr -d '\r' | awk '{print $2}')"
[[ "$got" == 200 && "$answer_sig" == "$(php -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2] . "." . file_get_contents($argv[3]), $argv[4]);' "$answered_at" "$n" "$work/export.b" "$export_secret")" ]] \
  && { pass=$((pass+1)); echo "ok   a signed request gets the export, and the answer is signed for its nonce"; } || { fail=$((fail+1)); echo "FAIL export good: $got $(head -c 300 "$work/export.b")"; }
summary="$(php -r '$d = json_decode(file_get_contents($argv[1]), true); $b = []; foreach ($d["phone"] as $p) { $b[$p["customerId"]] = $p["balanceMils"] . "/" . $p["state"]; } $i = array_filter($d["installs"], fn($r) => $r["customerId"] === "demo-shop"); echo count($i), " ", $b["demo-phone"] ?? "-", " ", count($d["ledger"]) > 0 ? "ledger" : "none"; foreach ($d["licences"] as $l) { if ($l["customerId"] === "demo-shop") { echo " ", $l["status"], ":", $l["plan"], ":", implode("+", $l["addons"]); } }' "$work/export.b")"
[[ "$summary" == "2 23400/ok ledger canceled:team:phone" ]] \
  && { pass=$((pass+1)); echo "ok   the export carries installs, phone balances with their state, the ledger and licences"; } || { fail=$((fail+1)); echo "FAIL export content: $summary"; }
! grep -q -e 'owner@shop.example' -e 'owner@gulf.example' -e 'ARK1-' -e 'cus_' -e 'sub_' -e 'cs_test' -e '"CA0' -e '"GR"' -e '"AE"' -e '127.0.0.1' "$work/export.b" \
  && { pass=$((pass+1)); echo "ok   the export has no email, country, licence key, Stripe id, call id or IP"; } || { fail=$((fail+1)); echo "FAIL export leaks: $(grep -o -e 'owner@[a-z.]*' -e 'ARK1-.\{8\}' -e 'cus_[0-9]*' -e 'sub_[0-9]*' "$work/export.b" | head -3)"; }
[[ "$(export_call "$t" "$n" "$(sign_export "$t" "$n" "$want")")" == 409 ]] \
  && { pass=$((pass+1)); echo "ok   the same signed request sent again is refused (replay)"; } || { fail=$((fail+1)); echo "FAIL export replay"; }
cat > "$repo/.checkin-export.ts" <<'TS'
import { checkinExport } from "./infra/control-board/sources";
const [url, secret] = process.argv.slice(2);
const data = await checkinExport({ url, secret }).load();
console.log(`${data.installs.length} ${data.phone.length}`);
const bad = await checkinExport({ url, secret: "a-different-secret-0123456789abcdefgh" }).load().then(() => "read", (e: Error) => e.message);
console.log(bad);
TS
board="$(cd "$repo" && bun .checkin-export.ts "$export_url" "$export_secret" 2>&1)"; rm -f "$repo/.checkin-export.ts"
[[ "$(head -1 <<<"$board")" =~ ^[0-9]+\ [1-9][0-9]*$ && "$(tail -1 <<<"$board")" == "The check-in export answered 403." ]] \
  && { pass=$((pass+1)); echo "ok   the Control Board's own client reads the export, and is refused with a wrong secret"; } || { fail=$((fail+1)); echo "FAIL board client: $board"; }

# Help & support (#149): the app's request, checked against the install's signed profile or code,
# forwarded to the Control Board signed with intake_secret, with the customer's plan.
support="http://127.0.0.1:$port/checkin/support/"
uuid() { php -r 'printf("%04x%04x-%04x-4%03x-a%03x-%012x", random_int(0, 65535), random_int(0, 65535), random_int(0, 65535), random_int(0, 4095), random_int(0, 4095), random_int(0, 281474976710655));'; }
support_body() { # customer install proof-json [subject]
  echo "{\"requestId\":\"$(uuid)\",\"customerId\":\"$1\",\"installId\":\"$2\",\"appVersion\":\"0.1.49\",\"language\":\"el\",\"subject\":\"${4:-Δεν ανοίγει το Gmail}\",\"message\":\"Μετά την ενημέρωση ζητάει ξανά σύνδεση.\",\"urgent\":true,\"diagnostics\":{\"appVersion\":\"0.1.49\",\"os\":\"Windows 11 (x64)\",\"logs\":[\"error mailbox: sign-in refused\"]},\"proof\":$3}"
}
send_support() { curl -s -o "$work/support.out" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$1" "$support"; }
profile_proof() { php -r '$d = json_decode($argv[1], true); $d["kind"] = "profile"; echo json_encode($d);' "$1"; }
inst=1b2c3d4e-0000-4000-8000-0000000000a1
expect "Help & support refuses GET" 405 "$support"
got="$(send_support "$(support_body demo-shop "$inst" "$(profile_proof "$good")")")"
received="$work/board/received.json"
[[ "$got" == 200 && "$(cat "$work/support.out")" == '{"case":7}' ]] \
  && [[ "$(php -r '$d = json_decode(file_get_contents($argv[1]), true); echo $d["customerId"], " ", $d["plan"], " ", $d["urgent"] ? "urgent" : "normal", " ", $d["subject"], " ", count($d["diagnostics"]["logs"]), " ", array_key_exists("proof", $d) ? "proof!" : "no-proof";' "$received")" == "demo-shop trial urgent Δεν ανοίγει το Gmail 1 no-proof" ]] \
  && { pass=$((pass+1)); echo "ok   a request with the install's signed profile is forwarded, signed, with the plan (trial) and no proof, and the case number comes back"; } || { fail=$((fail+1)); echo "FAIL support forward: $got $(cat "$work/support.out") $(cat "$received" 2>/dev/null | head -c 300)"; }
expect "a profile signed for another customer is refused" 403 -X POST --data "$(support_body demo-shop "$inst" "$(profile_proof "$other")")" "$support"
expect "a profile signed with another key is refused" 403 -X POST --data "$(support_body demo-shop "$inst" "$(profile_proof "$wrong")")" "$support"
expect "no proof at all is refused" 403 -X POST --data "$(support_body demo-shop "$inst" '{}')" "$support"
# A licence key for demo-phone, signed with the test licence key, as license-keygen's key would be.
licence="$(php -r '$p = rtrim(strtr(base64_encode(json_encode(["v" => 1, "action" => "license", "customer" => "demo-phone", "nonce" => "n1", "issuedAt" => "2026-11-18T00:00:00Z", "plan" => "team", "seats" => 1, "validUntil" => "2099-01-01T00:00:00Z"])), "+/", "-_"), "="); $s = rtrim(strtr(base64_encode(sodium_crypto_sign_detached($p, base64_decode($argv[1]))), "+/", "-_"), "="); echo json_encode(["kind" => "code", "payload" => $p, "signature" => $s]);' "$license_secret")"
got="$(send_support "$(support_body demo-phone 1b2c3d4e-0000-4000-8000-0000000000a2 "$licence")")"
[[ "$got" == 200 && "$(php -r 'echo json_decode(file_get_contents($argv[1]), true)["plan"];' "$received")" == paid ]] \
  && { pass=$((pass+1)); echo "ok   a request with the install's licence key is forwarded as paid (an active licence is on file)"; } || { fail=$((fail+1)); echo "FAIL support licence: $got $(cat "$work/support.out")"; }
forged="$(php -r '$d = json_decode($argv[1], true); $d["signature"] = rtrim(strtr(base64_encode(random_bytes(64)), "+/", "-_"), "="); echo json_encode($d);' "$licence")"
expect "a licence key with a forged signature is refused" 403 -X POST --data "$(support_body demo-phone 1b2c3d4e-0000-4000-8000-0000000000a2 "$forged")" "$support"
expect "a licence key for another customer is refused" 403 -X POST --data "$(support_body demo-shop 1b2c3d4e-0000-4000-8000-0000000000a2 "$licence")" "$support"
expect "when the board cannot take it, the app is told to send it again" 502 -X POST --data "$(support_body demo-shop "$inst" "$(profile_proof "$good")" board-down)" "$support"
expect "not a support request" 400 -X POST --data '{"customerId":"demo-shop"}' "$support"
for _ in $(seq 1 8); do send_support "$(support_body demo-shop "$inst" "$(profile_proof "$good")")" >/dev/null; done
expect "the 11th request from one install in a day is refused" 429 -X POST --data "$(support_body demo-shop "$inst" "$(profile_proof "$good")")" "$support"

# Before activation (Amgad, 23 Nov): no proof, customer "unverified", 3 a day per install and per address.
unverified_body() { # install [extra-json-fields]
  echo "{\"requestId\":\"$(uuid)\",\"customerId\":\"unverified\",\"installId\":\"$1\",\"appVersion\":\"0.1.52\",\"language\":\"en\",\"subject\":\"I cannot activate\",\"message\":\"The code is refused.\",\"urgent\":false,\"diagnostics\":null,\"proof\":null${2:-}}"
}
fresh=1b2c3d4e-0000-4000-8000-0000000000b1
got="$(send_support "$(unverified_body "$fresh" ',"contactEmail":"maria@example.com"')")"
[[ "$got" == 200 && "$(php -r '$d = json_decode(file_get_contents($argv[1]), true); echo $d["customerId"], " ", $d["plan"], " ", $d["contactEmail"], " ", array_key_exists("proof", $d) ? "proof!" : "no-proof";' "$received")" == "unverified none maria@example.com no-proof" ]] \
  && { pass=$((pass+1)); echo "ok   before activation: a request with no proof is forwarded as customer unverified, plan none, with the contact address"; } || { fail=$((fail+1)); echo "FAIL unverified forward: $got $(cat "$work/support.out") $(head -c 300 "$received")"; }
expect "an unverified request with any proof is refused (proof means a customer is named)" 400 -X POST --data "$(support_body unverified "$fresh" "$(profile_proof "$good")")" "$support"
expect "a contact address on a signed request is refused" 400 -X POST --data "$(php -r '$d = json_decode($argv[1], true); $d["contactEmail"] = "a@b.cd"; echo json_encode($d);' "$(support_body demo-phone 1b2c3d4e-0000-4000-8000-0000000000a2 "$licence")")" "$support"
expect "a contact address that is not one is refused" 400 -X POST --data "$(unverified_body "$fresh" ',"contactEmail":"a@b.cd\r\nBcc: x@y.z"')" "$support"
expect "a customer id with no proof is still refused" 403 -X POST --data "$(support_body demo-shop "$fresh" null)" "$support"
send_support "$(unverified_body "$fresh")" >/dev/null; send_support "$(unverified_body "$fresh")" >/dev/null
expect "the 4th unverified request from one install in a day is refused" 429 -X POST --data "$(unverified_body "$fresh")" "$support"
expect "and from the same address, a new install is refused too" 429 -X POST --data "$(unverified_body 1b2c3d4e-0000-4000-8000-0000000000b2)" "$support"
got="$(send_support "$(support_body demo-phone 1b2c3d4e-0000-4000-8000-0000000000a2 "$licence")")"
[[ "$got" == 200 ]] && { pass=$((pass+1)); echo "ok   a signed install from that address still gets through (its own limit is 10)"; } || { fail=$((fail+1)); echo "FAIL signed after unverified: $got"; }
[[ "$(php -r '$db = new PDO("sqlite:" . $argv[1]); echo $db->query("SELECT COUNT(*) FROM support_unverified")->fetchColumn(), " ", $db->query("SELECT COUNT(*) FROM support_unverified WHERE address_hash LIKE \"%127.0.0.1%\" OR length(address_hash) <> 64")->fetchColumn();' "$work/checkin/data/checkins.sqlite")" == "3 0" ]] \
  && { pass=$((pass+1)); echo "ok   the address is kept only as a keyed hash"; } || { fail=$((fail+1)); echo "FAIL address stored"; }

# BlackArk's replies for the app (Gap 3): the same proof as a request, then the board's answer, trimmed.
replies_url="http://127.0.0.1:$port/checkin/support/replies/"
replied=1b2c3d4e-0000-4000-8000-0000000000c1
ask_replies() { curl -s -o "$work/replies.out" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$1" "$replies_url"; }
expect "replies refuse GET" 405 "$replies_url"
got="$(ask_replies "{\"customerId\":\"unverified\",\"installId\":\"$replied\",\"proof\":null}")"
[[ "$got" == 200 && "$(cat "$work/replies.out")" == '{"cases":[{"case":9,"subject":"Δεν ανοίγει","status":"waiting","openedAt":"2026-11-24T10:00:00.000Z","replies":[{"at":"2026-11-24T11:00:00.000Z","language":"el","text":"Δοκιμάστε ξανά.","english":"Please try again."}]}]}' \
  && "$(cat "$work/board/replies.json")" == "{\"customerId\":\"unverified\",\"installId\":\"$replied\"}" ]] \
  && { pass=$((pass+1)); echo "ok   before activation: an install's replies come back from the board, without anything the app does not show"; } || { fail=$((fail+1)); echo "FAIL replies unverified: $got $(cat "$work/replies.out")"; }
got="$(ask_replies "{\"customerId\":\"demo-shop\",\"installId\":\"$inst\",\"proof\":$(profile_proof "$good")}")"
[[ "$got" == 200 && "$(cat "$work/replies.out")" == '{"cases":[]}' && "$(cat "$work/board/replies.json")" == "{\"customerId\":\"demo-shop\",\"installId\":\"$inst\"}" ]] \
  && { pass=$((pass+1)); echo "ok   with the install's signed profile, the board is asked for that customer and install only"; } || { fail=$((fail+1)); echo "FAIL replies signed: $got $(cat "$work/replies.out")"; }
expect "replies with a profile signed for another customer are refused" 403 -X POST --data "{\"customerId\":\"demo-shop\",\"installId\":\"$inst\",\"proof\":$(profile_proof "$other")}" "$replies_url"
expect "replies for a customer with no proof are refused" 403 -X POST --data "{\"customerId\":\"demo-shop\",\"installId\":\"$inst\",\"proof\":null}" "$replies_url"
expect "replies: unverified with a proof is refused" 400 -X POST --data "{\"customerId\":\"unverified\",\"installId\":\"$inst\",\"proof\":$(profile_proof "$good")}" "$replies_url"
expect "replies: an install id that is not one is refused" 400 -X POST --data '{"customerId":"unverified","installId":"../x","proof":null}' "$replies_url"
for _ in $(seq 1 59); do ask_replies "{\"customerId\":\"unverified\",\"installId\":\"$replied\",\"proof\":null}" >/dev/null; done
expect "the 61st replies request from one install in an hour is refused" 429 -X POST --data "{\"customerId\":\"unverified\",\"installId\":\"$replied\",\"proof\":null}" "$replies_url"
[[ "$(php -r '$db = new PDO("sqlite:" . $argv[1]); echo implode(",", array_column($db->query("PRAGMA table_info(support_reply_reads)")->fetchAll(), "name"));' "$work/checkin/data/checkins.sqlite")" == "install_id,at" ]] \
  && { pass=$((pass+1)); echo "ok   replies keep only the install id and the time, never the address"; } || { fail=$((fail+1)); echo "FAIL replies store more than install id and time"; }

# The Control Board's off-site audit copy (#149): signed, append-only, only a batch that continues
# the chain; driven by the board's own client (cron.ts) against a throwaway board store.
copy_url="http://127.0.0.1:$port/checkin/audit-copy/"
expect "the audit copy refuses GET" 405 "$copy_url"
expect "the audit copy refuses an unsigned request" 403 -X POST --data '{"prevHash":"0","entries":[]}' "$copy_url"
mkdir -p "$work/boardstore"
cat > "$repo/.checkin-audit-copy.ts" <<'TS'
import { appendAudit, type AuditRow, rowHash } from "./infra/control-board/audit";
import { blackarkCopy, copyAudit, signCopy } from "./infra/control-board/cron";
import { openLocalStore } from "./infra/control-board/sql-sqlite";
const [url, secret, dir] = process.argv.slice(2) as [string, string, string];
const sql = await openLocalStore(`${dir}/board.sqlite`);
const copy = blackarkCopy({ url, secret });
const add = (detail: string | null, target = "customer:demo-shop") =>
  appendAudit(sql, { actor: "maria", role: "support", action: "view", target, outcome: "ok", detail }, Date.now());
// Text that JSON writes differently in many places: Greek, a slash, quotes, a newline, U+2028, a tab.
await add("Δεν ανοίγει / \"Gmail\"\nline next\ttab");
for (let i = 0; i < 4; i++) await add(null, `customer:c${i}`);
const say = (line: string) => console.log(line);
say(`first ${await copyAudit(sql, copy, Date.now())}`);
say(`again ${await copyAudit(sql, copy, Date.now())}`);
await add("later");
await add(null);
say(`new ${await copyAudit(sql, copy, Date.now())}`);
const rows = await sql.all<AuditRow>("SELECT * FROM audit ORDER BY id");
const post = async (batch: unknown, nonce = crypto.randomUUID().replaceAll("-", "")) => {
  const body = JSON.stringify(batch);
  const time = String(Math.floor(Date.now() / 1000));
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-ark-time": time, "x-ark-nonce": nonce, "x-ark-signature": signCopy(secret, time, nonce, body) },
    body,
  });
  return `${response.status} ${await response.text()}`;
};
// The board lost an answer and sends a batch again, overlapping what is kept: taken, nothing doubled.
say(`resend ${await post({ prevHash: (rows[1] as AuditRow).hash, entries: rows.slice(2) })}`);
// Entry 3 rewritten, its chain recomputed so it looks valid on its own: refused.
const prev = (rows[1] as AuditRow).hash;
const forged = { ...(rows[2] as AuditRow), actor: "someone-else" };
forged.hash = rowHash(prev, forged);
say(`rewrite ${(await post({ prevHash: prev, entries: [forged] })).split(" ")[0]}`);
say(`gap ${(await post({ prevHash: (rows[1] as AuditRow).hash, entries: rows.slice(3) })).split(" ")[0]}`);
say(`unknown ${(await post({ prevHash: "a".repeat(64), entries: [] })).split(" ")[0]}`);
const nonce = "replay-nonce-0123456789";
await post({ prevHash: (rows.at(-1) as AuditRow).hash, entries: [] }, nonce);
say(`replay ${(await post({ prevHash: (rows.at(-1) as AuditRow).hash, entries: [] }, nonce)).split(" ")[0]}`);
const other = blackarkCopy({ url, secret: "a-different-secret-0123456789abcdefgh" });
await add(null);
say(`wrong-secret ${await copyAudit(sql, other, Date.now()).then(String, (e: Error) => e.message)}`);
TS
copied="$(cd "$repo" && bun .checkin-audit-copy.ts "$copy_url" 'audit-copy-secret-for-tests-0123456789abcdef' "$work/boardstore" 2>&1)"; rm -f "$repo/.checkin-audit-copy.ts"
line() { grep "^$1 " <<<"$copied" | head -1 | cut -d' ' -f2-; }
[[ "$(line first)" == 5 && "$(line again)" == 0 && "$(line new)" == 2 ]] \
  && { pass=$((pass+1)); echo "ok   the board's client copies its entries (Greek, quotes, newlines and all), then only what is new"; } || { fail=$((fail+1)); echo "FAIL audit copy client: $copied"; }
[[ "$(line resend)" == '200 {"stored":0,"lastId":7}' ]] \
  && { pass=$((pass+1)); echo "ok   a batch sent again over what is kept is taken, and nothing is doubled"; } || { fail=$((fail+1)); echo "FAIL audit copy resend: $(line resend)"; }
[[ "$(line rewrite)" == 409 && "$(line gap)" == 409 && "$(line unknown)" == 409 ]] \
  && { pass=$((pass+1)); echo "ok   a rewritten entry, a gap, and a batch that does not continue the copy are refused (409)"; } || { fail=$((fail+1)); echo "FAIL audit copy refusals: $copied"; }
[[ "$(line replay)" == 409 ]] \
  && { pass=$((pass+1)); echo "ok   the same signed batch sent again is refused (replay)"; } || { fail=$((fail+1)); echo "FAIL audit copy replay: $(line replay)"; }
[[ "$(line wrong-secret)" == "The audit copy answered 403." ]] \
  && { pass=$((pass+1)); echo "ok   a batch signed with another secret is refused"; } || { fail=$((fail+1)); echo "FAIL audit copy secret: $(line wrong-secret)"; }
kept="$(php -r '$db = new PDO("sqlite:" . $argv[1]); $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); $n = $db->query("SELECT COUNT(*) FROM audit_copy")->fetchColumn(); $out = [$n]; foreach (["UPDATE audit_copy SET actor = 1", "DELETE FROM audit_copy"] as $q) { try { $db->exec($q); $out[] = "changed"; } catch (PDOException $e) { $out[] = str_contains($e->getMessage(), "append-only") ? "refused" : "error"; } } echo implode(" ", $out);' "$work/checkin/data/checkins.sqlite")"
[[ "$kept" == "7 refused refused" ]] \
  && { pass=$((pass+1)); echo "ok   the copy keeps 7 entries, and the database refuses to change or remove one"; } || { fail=$((fail+1)); echo "FAIL audit copy store: $kept"; }

# Counts-only check-in fields (#149, v0.1.49): accepted, stored, exported; nothing else is.
counts='{"customerId":"demo-clinic","installId":"2c3d4e5f-0000-4000-8000-0000000000c1","version":"0.1.49","status":"trial","daysLeft":20,"employees":4,"people":5,"activePeople7d":3,"conversations7d":41,"phoneLine":true,"os":"windows"}'
[[ "$(post "$counts")" == 204 ]] && { pass=$((pass+1)); echo "ok   a v0.1.49 check-in with counts is stored (204)"; } || { fail=$((fail+1)); echo "FAIL counts check-in"; }
bad_counts() { echo "${counts/2c3d4e5f-0000-4000-8000-0000000000c1/2c3d4e5f-0000-4000-8000-0000000000c2}" | sed "s/$1/$2/"; }
expect "more people active than people is refused" 400 -X POST -H 'content-type: application/json' --data "$(bad_counts '"activePeople7d":3' '"activePeople7d":9')" "$url"
expect "an unknown system is refused" 400 -X POST -H 'content-type: application/json' --data "$(bad_counts '"os":"windows"' '"os":"beos"')" "$url"
expect "a phone line that is not true or false is refused" 400 -X POST -H 'content-type: application/json' --data "$(bad_counts '"phoneLine":true' '"phoneLine":"yes"')" "$url"
expect "a name is still refused" 400 -X POST -H 'content-type: application/json' --data "$(bad_counts '"os":"windows"' '"os":"windows","name":"Maria"')" "$url"
t="$(date +%s)"; n="nonce-$(php -r 'echo bin2hex(random_bytes(8));')"
export_call "$t" "$n" "$(sign_export "$t" "$n" "$want")" >/dev/null
row="$(php -r '$d = json_decode(file_get_contents($argv[1]), true); foreach ($d["installs"] as $i) { if ($i["installId"] === $argv[2]) { echo json_encode([$i["people"], $i["activePeople7d"], $i["conversations7d"], $i["phoneLine"], $i["os"]]); } }' "$work/export.b" 2c3d4e5f-0000-4000-8000-0000000000c1)"
old="$(php -r '$d = json_decode(file_get_contents($argv[1]), true); foreach ($d["installs"] as $i) { if ($i["installId"] === $argv[2]) { echo json_encode([$i["people"], $i["os"]]); } }' "$work/export.b" 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b)"
[[ "$row" == '[5,3,41,true,"windows"]' && "$old" == '[null,null]' ]] \
  && { pass=$((pass+1)); echo "ok   the export carries the counts, and none for an older install"; } || { fail=$((fail+1)); echo "FAIL counts export: $row / $old"; }

# Ark Team tiers (v0.1.49): the price table's max_agents, signed into the key; a tier switch or a seat
# change in the portal re-signs at once; the old EUR 100 price is 5 agents; an unknown price changes
# nothing; a failed payment stops new keys until the next paid invoice.
key_of() { # customer -> the latest active key's payload as JSON, "none" if there is none
  php -r '$db = new PDO("sqlite:" . $argv[1]); $q = $db->prepare("SELECT license_key FROM licenses WHERE customer_id = ? AND status = \"active\" ORDER BY updated_at DESC LIMIT 1"); $q->execute([$argv[2]]); $k = $q->fetchColumn(); if (!$k) { echo "none"; exit; } [$p, $s] = explode(".", substr($k, 5)); $ok = sodium_crypto_sign_verify_detached(base64_decode(strtr($s, "-_", "+/")), $p, base64_decode($argv[3])); $d = json_decode(base64_decode(strtr($p, "-_", "+/")), true); echo $ok ? json_encode([$d["plan"], $d["seats"], $d["maxAgents"] ?? null, $d["validUntil"]]) : "badsig";' "$work/checkin/data/checkins.sqlite" "$1" "$license_public"
}
nonce_of() { php -r '$db = new PDO("sqlite:" . $argv[1]); $q = $db->prepare("SELECT license_key FROM licenses WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1"); $q->execute([$argv[2]]); [$p] = explode(".", substr((string) $q->fetchColumn(), 5)); echo json_decode(base64_decode(strtr($p, "-_", "+/")), true)["nonce"] ?? "";' "$work/checkin/data/checkins.sqlite" "$1"; }
until_of() { php -r '$db = new PDO("sqlite:" . $argv[1]); $q = $db->prepare("SELECT valid_until FROM licenses WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1"); $q->execute([$argv[2]]); echo $q->fetchColumn();' "$work/checkin/data/checkins.sqlite" "$1"; }
tend=$(( $(date +%s) + 30*86400 ))
want_until="$(php -r 'echo gmdate("Y-m-d\TH:i:s\Z", (int) $argv[1] + 7 * 86400);' "$tend")"
send_event '{"id":"evt_tier1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_tier1","client_reference_id":"demo-tier","customer":"cus_9","subscription":"sub_9"}}}' >/dev/null
send_event '{"id":"evt_tier2","type":"invoice.paid","data":{"object":{"subscription":"sub_9","lines":{"data":[{"price":{"id":"price_tier10"},"quantity":3,"period":{"end":'"$tend"'}}]}}}}' >/dev/null
[[ "$(key_of demo-tier)" == '["team",3,10,"'"$want_until"'"]' ]] \
  && { pass=$((pass+1)); echo "ok   a paid 10-agent tier with 3 seats signs team, 3 seats, maxAgents 10"; } || { fail=$((fail+1)); echo "FAIL tier key: $(key_of demo-tier)"; }
before="$(nonce_of demo-tier)"
switch='{"id":"evt_tier3","type":"customer.subscription.updated","data":{"object":{"id":"sub_9","object":"subscription","status":"active","customer":"cus_9","items":{"data":[{"price":{"id":"price_tier20"},"quantity":3,"current_period_end":'"$tend"'}]}}}}'
[[ "$(send_event "$switch")" == 200 && "$(key_of demo-tier)" == '["team",3,20,"'"$want_until"'"]' && "$(nonce_of demo-tier)" != "$before" ]] \
  && { pass=$((pass+1)); echo "ok   a tier switch in the portal signs a new key at once, maxAgents 20, same period"; } || { fail=$((fail+1)); echo "FAIL tier switch: $(key_of demo-tier)"; }
got="$(curl -s -X POST --data '{"customerId":"demo-tier","installId":"5b0c2f9e-1d4a-4c8e-9f3b-7a6d2e1c0b9a","nonce":"'"$before"'","validUntil":"'"$(until_of demo-tier)"'"}' "$renew")"
grep -q '"key":"ARK1-' <<<"$got" && { pass=$((pass+1)); echo "ok   renewal hands the switched key to an install whose key has the same end but another nonce"; } || { fail=$((fail+1)); echo "FAIL renew after switch: $got"; }
got="$(curl -s -X POST --data '{"customerId":"demo-tier","nonce":"'"$(nonce_of demo-tier)"'","validUntil":"'"$(until_of demo-tier)"'"}' "$renew")"
[[ "$got" == '{}' ]] && { pass=$((pass+1)); echo "ok   and nothing to the install that already has it"; } || { fail=$((fail+1)); echo "FAIL renew same key: $got"; }
seats='{"id":"evt_tier4","type":"customer.subscription.updated","data":{"object":{"id":"sub_9","object":"subscription","status":"active","customer":"cus_9","items":{"data":[{"price":{"id":"price_tier20"},"quantity":5,"current_period_end":'"$tend"'}]}}}}'
[[ "$(send_event "$seats")" == 200 && "$(key_of demo-tier)" == '["team",5,20,"'"$want_until"'"]' ]] \
  && { pass=$((pass+1)); echo "ok   a seat change signs a new key with 5 seats"; } || { fail=$((fail+1)); echo "FAIL seat change: $(key_of demo-tier)"; }
before="$(nonce_of demo-tier)"
unknown='{"id":"evt_tier5","type":"customer.subscription.updated","data":{"object":{"id":"sub_9","object":"subscription","status":"active","customer":"cus_9","items":{"data":[{"price":{"id":"price_nobody_knows"},"quantity":9,"current_period_end":'"$tend"'}]}}}}'
answer="$(t="$(date +%s)"; curl -s -X POST -H "stripe-signature: t=$t,v1=$(php -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2], "whsec_test");' "$t" "$unknown")" --data "$unknown" "$stripe")"
[[ "$answer" == *"price table"* && "$(key_of demo-tier)" == '["team",5,20,"'"$want_until"'"]' && "$(nonce_of demo-tier)" == "$before" ]] \
  && { pass=$((pass+1)); echo "ok   an unknown price changes nothing and says so"; } || { fail=$((fail+1)); echo "FAIL unknown price: $answer $(key_of demo-tier)"; }
send_event '{"id":"evt_old1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_old1","client_reference_id":"demo-old","customer":"cus_8","subscription":"sub_8"}}}' >/dev/null
send_event '{"id":"evt_old2","type":"invoice.paid","data":{"object":{"subscription":"sub_8","lines":{"data":[{"price":{"id":"price_team"},"quantity":2,"period":{"end":'"$tend"'}}]}}}}' >/dev/null
[[ "$(key_of demo-old)" == '["team",2,5,"'"$want_until"'"]' ]] \
  && { pass=$((pass+1)); echo "ok   the old EUR 100 price signs as the 5-agent tier"; } || { fail=$((fail+1)); echo "FAIL old price: $(key_of demo-old)"; }
before="$(nonce_of demo-old)"
send_event '{"id":"evt_old3","type":"invoice.payment_failed","data":{"object":{"subscription":"sub_8"}}}' >/dev/null
send_event '{"id":"evt_old4","type":"customer.subscription.updated","data":{"object":{"id":"sub_8","object":"subscription","status":"past_due","customer":"cus_8","items":{"data":[{"price":{"id":"price_tier10"},"quantity":2,"current_period_end":'"$tend"'}]}}}}' >/dev/null
[[ "$(nonce_of demo-old)" == "$before" && "$(key_of demo-old)" == none ]] \
  && { pass=$((pass+1)); echo "ok   after a failed payment no new key is signed, and renewal hands out none"; } || { fail=$((fail+1)); echo "FAIL payment failed: $(key_of demo-old)"; }
send_event '{"id":"evt_old5","type":"invoice.paid","data":{"object":{"subscription":"sub_8","lines":{"data":[{"price":{"id":"price_tier10"},"quantity":2,"period":{"end":'"$tend"'}}]}}}}' >/dev/null
[[ "$(key_of demo-old)" == '["team",2,10,"'"$want_until"'"]' ]] \
  && { pass=$((pass+1)); echo "ok   the next paid invoice brings it back, on the tier it is on now"; } || { fail=$((fail+1)); echo "FAIL after paid: $(key_of demo-old)"; }
send_event '{"id":"evt_old6","type":"customer.subscription.deleted","data":{"object":{"id":"sub_8"}}}' >/dev/null
[[ "$(key_of demo-old)" == none ]] && { pass=$((pass+1)); echo "ok   a deleted subscription gets no more keys"; } || { fail=$((fail+1)); echo "FAIL deleted: $(key_of demo-old)"; }
cat > "$repo/.checkin-tier.ts" <<'TS'
import { readActivationCode } from "./shared/activation";
const read = readActivationCode(process.argv[2] ?? "");
console.log(read.code.action === "license" ? `${read.code.seats}x${read.code.maxAgents}` : "no");
TS
tierkey="$(php -r '$db = new PDO("sqlite:" . $argv[1]); echo $db->query("SELECT license_key FROM licenses WHERE customer_id = \"demo-tier\"")->fetchColumn();' "$work/checkin/data/checkins.sqlite")"
read_back="$(cd "$repo" && bun .checkin-tier.ts "$tierkey")"; rm -f "$repo/.checkin-tier.ts"
[[ "$read_back" == "5x20" ]] && { pass=$((pass+1)); echo "ok   the app reads the signed tier: 5 seats x 20"; } || { fail=$((fail+1)); echo "FAIL app read: $read_back"; }

# The buy page lets the customer choose the tier (v0.1.49), in Greek and English, per seat.
choose="$(curl -s "$buy?customer=demo-buy&phone=1")"
grep -q 'tier=5&amp;phone=1' <<<"$choose" && grep -q 'tier=10&amp;phone=1' <<<"$choose" && grep -q 'tier=20&amp;phone=1' <<<"$choose" \
  && grep -q '€140' <<<"$choose" && grep -q '€200' <<<"$choose" && grep -q 'ανά άτομο' <<<"$choose" && grep -q 'per person a month' <<<"$choose" \
  && ! grep -q 'price_' <<<"$choose" \
  && { pass=$((pass+1)); echo "ok   without a tier the buy page offers 5, 10 and 20 with their prices per person, in both languages"; } || { fail=$((fail+1)); echo "FAIL tier choice page"; }
[[ "$(location "$buy?customer=demo-buy&tier=10")" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] \
  && grep -q 'price%5D=price_tier10' <(last) && ! grep -q 'price_team' <(last) && ! grep -q 'price_phone' <(last) \
  && grep -q 'adjustable_quantity%5D%5Benabled%5D=true' <(last) \
  && { pass=$((pass+1)); echo "ok   the 10 tier opens a checkout with its own price, the seats adjustable"; } || { fail=$((fail+1)); echo "FAIL tier checkout: $(last)"; }
[[ "$(location "$buy?customer=demo-buy&tier=20&phone=1")" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] \
  && grep -q 'price%5D=price_tier20' <(last) && grep -q 'price%5D=price_phone' <(last) && grep -q 'price%5D=price_block5h' <(last) \
  && { pass=$((pass+1)); echo "ok   the 20 tier with the phone add-on and its first 5-hour block"; } || { fail=$((fail+1)); echo "FAIL tier + phone: $(last)"; }
expect "a tier that is not sold is refused" 400 "$buy?customer=demo-buy&tier=15"

# Phone usage to Stripe's meters (v0.1.49): one event per part, whole minutes, an identifier from the
# call and the part so a retry never counts twice; never in the way of the call or the balance.
meter_sent() { grep '^/fakestripe/v1/billing/meter_events ' "$work/fake/sent.log" || true; }
waiting() { php -r '$db = new PDO("sqlite:" . $argv[1]); echo $db->query("SELECT COUNT(*) FROM meter_events WHERE sent_at IS NULL AND customer_id = " . $db->quote($argv[2]))->fetchColumn();' "$work/checkin/data/checkins.sqlite" "$1"; }
mcall() { echo "{\"action\":\"charge\",\"customerId\":\"$1\",\"callId\":\"CA$(printf '%032d' "$2")\",\"parts\":$3}"; }
send_event '{"id":"evt_m1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_meter1","client_reference_id":"demo-meter","customer":"cus_7","subscription":"sub_7","payment_status":"paid","metadata":{"kind":"subscription","phone_blocks":"1"}}}}' >/dev/null
touch "$work/fake/meter_down"
got="$(relay_call "$(mcall demo-meter 71 '[{"kind":"incoming","seconds":125},{"kind":"landline","seconds":60}]')")"
[[ "$(field "$got" balanceMils)" == $((23400 - 3*78 - 88)) && "$(waiting demo-meter)" == 2 ]] \
  && { pass=$((pass+1)); echo "ok   with Stripe down the call is still charged and answered; its two meter events wait"; } || { fail=$((fail+1)); echo "FAIL meter down: $got / $(waiting demo-meter)"; }
rm -f "$work/fake/meter_down"
relay_call "$(mcall demo-meter 72 '[{"kind":"mobile","seconds":30}]')" >/dev/null
relay_call "$(mcall demo-meter 72 '[{"kind":"mobile","seconds":30}]')" >/dev/null
ids="$(meter_sent | grep -c 'rk_test_meter' || true)"
meter_sent | grep -q 'event_name=arkagent_phone_minutes_incoming&payload%5Bstripe_customer_id%5D=cus_7&payload%5Bvalue%5D=3&identifier=call_CA00000000000000000000000000000071_incoming' \
  && meter_sent | grep -q 'event_name=arkagent_phone_minutes_landline&payload%5Bstripe_customer_id%5D=cus_7&payload%5Bvalue%5D=1&identifier=call_CA00000000000000000000000000000071_landline' \
  && meter_sent | grep -q 'event_name=arkagent_phone_minutes_mobile&payload%5Bstripe_customer_id%5D=cus_7&payload%5Bvalue%5D=1&identifier=call_CA00000000000000000000000000000072_mobile' \
  && [[ "$(waiting demo-meter)" == 0 ]] \
  && { pass=$((pass+1)); echo "ok   once Stripe answers, the waiting events go too: per part, whole minutes, the call and part as identifier"; } || { fail=$((fail+1)); echo "FAIL meter send: $(meter_sent | tail -3)"; }
[[ "$(meter_sent | grep -c '_CA00000000000000000000000000000072_mobile' || true)" == 1 && "$(meter_sent | grep -c '_CA00000000000000000000000000000071_incoming' || true)" == 2 ]] \
  && { pass=$((pass+1)); echo "ok   a repeated relay report sends nothing again; a failed send is retried under the same identifier"; } || { fail=$((fail+1)); echo "FAIL meter retry: $(meter_sent | grep -c CA)"; }
php -r '$db = new PDO("sqlite:" . $argv[1]); $db->exec("INSERT OR IGNORE INTO phone_accounts (customer_id, balance_mils, updated_at) VALUES (\"demo-nocus\", 23400, \"now\")");' "$work/checkin/data/checkins.sqlite"
before="$(meter_sent | wc -l)"
got="$(relay_call "$(mcall demo-nocus 73 '[{"kind":"incoming","seconds":60}]')")"
[[ "$(field "$got" balanceMils)" == $((23400 - 78)) && "$(waiting demo-nocus)" == 1 && "$(meter_sent | wc -l)" == "$before" ]] \
  && { pass=$((pass+1)); echo "ok   without a Stripe customer the call is charged and the event waits, unsent"; } || { fail=$((fail+1)); echo "FAIL no customer: $got"; }
cp "$work/checkin/config.php" "$work/config.keep"
sed -i "s/'stripe_meter_key' => 'rk_test_meter',/'stripe_meter_key' => '',/" "$work/checkin/config.php"
sleep 3 # PHP's opcache reads a changed file again only after 2 seconds
got="$(relay_call "$(mcall demo-meter 74 '[{"kind":"incoming","seconds":60}]')")"
[[ "$(field "$got" state)" == '"ok"' && "$(waiting demo-meter)" == 1 && "$(meter_sent | wc -l)" == "$before" ]] \
  && { pass=$((pass+1)); echo "ok   without the meter key the call is charged and the event waits, unsent"; } || { fail=$((fail+1)); echo "FAIL no key: $got $(waiting demo-meter) $(meter_sent | wc -l) $before"; }
cp "$work/config.keep" "$work/checkin/config.php"; sleep 3
t="$(date +%s)"; n="nonce-$(php -r 'echo bin2hex(random_bytes(8));')"
export_call "$t" "$n" "$(sign_export "$t" "$n" "$want")" >/dev/null
[[ "$(php -r '$d = json_decode(file_get_contents($argv[1]), true); echo json_encode($d["meterEventsWaiting"] ?? null);' "$work/export.b")" == 2 ]] && ! grep -q 'cus_' "$work/export.b" \
  && { pass=$((pass+1)); echo "ok   the export says how many meter events wait, and still no Stripe id"; } || { fail=$((fail+1)); echo "FAIL export waiting: $(grep -o '"meterEventsWaiting":[0-9a-z]*' "$work/export.b")"; }

# Ark Private Server (#149, 19 Nov): the app's list, the buy page's checkout, the webhook's order,
# staff attaching the server, and the key reaching only the paying install.
servers="http://127.0.0.1:$port/checkin/servers/"
srv_inst=5c6d7e8f-0000-4000-8000-0000000000c1
srv_body() { echo "{\"customerId\":\"$1\",\"installId\":\"$srv_inst\",\"proof\":$2}"; }
expect "the server list refuses GET" 405 "$servers"
expect "the server list without proof is refused" 403 -X POST --data '{"customerId":"demo-shop","installId":"'"$srv_inst"'"}' "$servers"
expect "the server list with another customer's proof is refused" 403 -X POST --data "$(srv_body demo-clinic "$(profile_proof "$good")")" "$servers"
list="$(curl -s -X POST --data "$(srv_body demo-shop "$(profile_proof "$good")")" "$servers")"
php -r '$d = json_decode($argv[1], true); $ids = array_column($d["tiers"], "id");
  exit($ids === ["small","medium","large","gpu_entry","gpu_high"] && $d["order"] === null
    && $d["tiers"][3]["monthlyCents"] === 35700 && $d["tiers"][3]["activationCents"] === 34800 && $d["tiers"][0]["storage"] === "100 GB"
    && $d["buyUrl"] === "https://blackark.example/checkin/buy/?customer=demo-shop&server=" ? 0 : 1);' "$list" \
  && { pass=$((pass+1)); echo "ok   the app gets the five tiers, with storage, model and prices, and no order yet"; } || { fail=$((fail+1)); echo "FAIL server list: $list"; }

got="$(location "$buy?customer=demo-shop&server=gpu_entry")"
[[ "$got" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] && grep -q 'mode=subscription' <(last) \
  && grep -q 'line_items%5B0%5D%5Bprice%5D=price_srvGpuM' <(last) && grep -q 'line_items%5B1%5D%5Bprice%5D=price_srvGpuA' <(last) \
  && grep -q 'metadata%5Bkind%5D=private_server' <(last) && grep -q 'subscription_data%5Bmetadata%5D%5Bserver_tier%5D=gpu_entry' <(last) \
  && grep -q 'client_reference_id=demo-shop' <(last) && grep -q 'done%3Dserver' <(last) \
  && { pass=$((pass+1)); echo "ok   a GPU server opens one subscription checkout: the monthly price and the one-time activation, found by lookup key"; } \
  || { fail=$((fail+1)); echo "FAIL server checkout ($got): $(last)"; }
got="$(location "$buy?customer=demo-shop&server=small")"
[[ "$got" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] && grep -q 'line_items%5B0%5D%5Bprice%5D=price_srvSmallM' <(last) && ! grep -q 'line_items%5B1%5D' <(last) \
  && { pass=$((pass+1)); echo "ok   a small server has the monthly price only"; } || { fail=$((fail+1)); echo "FAIL small checkout ($got)"; }
expect "a tier that is not offered is refused" 400 "$buy?customer=demo-shop&server=huge"
expect "a tier whose Stripe price is not set up is not sold" 503 "$buy?customer=demo-shop&server=medium"
touch "$work/fake/price_drift"
expect "a Stripe price that differs from the price shown is never charged" 503 "$buy?customer=demo-shop&server=small"
rm -f "$work/fake/price_drift"
branded "the server thank-you page" "$buy?done=server"

srv_checkout='{"id":"evt_srv_1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_server0001","client_reference_id":"demo-shop","customer":"cus_9","subscription":"sub_srv_1","payment_status":"paid","metadata":{"kind":"private_server","server_tier":"gpu_entry","customer_id":"demo-shop"}}}}'
[[ "$(send_event "$srv_checkout")" == 200 ]] && [[ "$(send_event "$srv_checkout")" == 200 ]] || { fail=$((fail+1)); echo "FAIL server checkout event"; }
srv_end=$(( $(date +%s) + 31*86400 ))
srv_invoice='{"id":"evt_srv_2","type":"invoice.paid","data":{"object":{"subscription":"sub_srv_1","lines":{"data":[{"price":{"id":"price_srvGpuM"},"quantity":1,"period":{"end":'"$srv_end"'}}]}}}}'
send_event "$srv_invoice" >/dev/null
db="$work/checkin/data/checkins.sqlite"
[[ "$(php -r '$d = new PDO("sqlite:" . $argv[1]); echo $d->query("SELECT COUNT(*) FROM private_servers")->fetchColumn(), " ", $d->query("SELECT COUNT(*) FROM licenses WHERE subscription_id = '"'"'sub_srv_1'"'"'")->fetchColumn();' "$db")" == "1 0" ]] \
  && { pass=$((pass+1)); echo "ok   a paid server order is kept once, and never as a licence"; } || { fail=$((fail+1)); echo "FAIL server order rows"; }
list="$(curl -s -X POST --data "$(srv_body demo-shop "$(profile_proof "$good")")" "$servers")"
php -r '$o = json_decode($argv[1], true)["order"]; exit($o["tier"] === "gpu_entry" && $o["status"] === "setting_up" && $o["apiKey"] === null && $o["baseUrl"] === null && $o["paidUntil"] !== null ? 0 : 1);' "$list" \
  && { pass=$((pass+1)); echo "ok   the app shows the order as being set up by BlackArk, paid until the invoice's end"; } || { fail=$((fail+1)); echo "FAIL order setting_up: $list"; }

page="$(curl -s -c "$jar" -b "$jar" "http://127.0.0.1:$port/checkin/admin/")"
csrf="$(grep -o 'name="csrf" value="[0-9a-f]*"' <<<"$page" | head -1 | sed 's/.*value="//; s/"//')"
grep -q 'Ark Private Server — GPU Entry' <<<"$page" && grep -q 'setting_up' <<<"$page" \
  && { pass=$((pass+1)); echo "ok   staff see the order waiting to be set up"; } || { fail=$((fail+1)); echo "FAIL admin order list"; }
attach() { curl -s -c "$jar" -b "$jar" --data-urlencode "action=server_attach" --data-urlencode "csrf=$1" --data-urlencode "subscription=sub_srv_1" \
  --data-urlencode "base_url=$2" --data-urlencode "model=qwen2.5:32b" --data-urlencode "api_key=$3" "http://127.0.0.1:$port/checkin/admin/"; }
grep -q 'must be https' <(attach "$csrf" "http://srv-1.example/v1" "sk-test-0123456789abcdef") \
  && { pass=$((pass+1)); echo "ok   an address that is not https is refused"; } || { fail=$((fail+1)); echo "FAIL http accepted"; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' --data "action=server_attach&csrf=nope&subscription=sub_srv_1" "http://127.0.0.1:$port/checkin/admin/")" == 403 ]] \
  && { pass=$((pass+1)); echo "ok   attaching without signing in is refused"; } || { fail=$((fail+1)); echo "FAIL attach without session"; }
page="$(attach "$csrf" "https://srv-1.example/v1" "sk-test-0123456789abcdef")"
grep -q 'Attached' <<<"$page" && ! grep -q 'sk-test-0123456789abcdef' <<<"$page" \
  && { pass=$((pass+1)); echo "ok   staff attach the server, and the key is not shown back"; } || { fail=$((fail+1)); echo "FAIL attach"; }
list="$(curl -s -X POST --data "$(srv_body demo-shop "$(profile_proof "$good")")" "$servers")"
php -r '$o = json_decode($argv[1], true)["order"]; exit($o["status"] === "ready" && $o["baseUrl"] === "https://srv-1.example/v1" && $o["model"] === "qwen2.5:32b" && $o["apiKey"] === "sk-test-0123456789abcdef" ? 0 : 1);' "$list" \
  && { pass=$((pass+1)); echo "ok   once attached, the paying install gets its address, model and key"; } || { fail=$((fail+1)); echo "FAIL ready order: $list"; }
# One server per customer, not per install (Amgad, 19 Nov 18:43): another install of the same customer
# gets the same server.
second="$(curl -s -X POST --data '{"customerId":"demo-shop","installId":"5c6d7e8f-0000-4000-8000-0000000000c2","proof":'"$(profile_proof "$good")"'}' "$servers")"
php -r '$o = json_decode($argv[1], true)["order"]; exit($o["status"] === "ready" && $o["baseUrl"] === "https://srv-1.example/v1" && $o["apiKey"] === "sk-test-0123456789abcdef" ? 0 : 1);' "$second" \
  && { pass=$((pass+1)); echo "ok   every install of the customer uses the same server"; } || { fail=$((fail+1)); echo "FAIL second install: $second"; }
other_list="$(curl -s -X POST --data "$(srv_body demo-clinic "$(profile_proof "$other")")" "$servers")"
! grep -q 'sk-test' <<<"$other_list" && php -r 'exit(json_decode($argv[1], true)["order"] === null ? 0 : 1);' "$other_list" \
  && { pass=$((pass+1)); echo "ok   another customer never sees it"; } || { fail=$((fail+1)); echo "FAIL other customer sees server: $other_list"; }
srv_end_event='{"id":"evt_srv_3","type":"customer.subscription.deleted","data":{"object":{"id":"sub_srv_1","metadata":{"kind":"private_server"}}}}'
send_event "$srv_end_event" >/dev/null
list="$(curl -s -X POST --data "$(srv_body demo-shop "$(profile_proof "$good")")" "$servers")"
php -r '$o = json_decode($argv[1], true)["order"]; exit($o["status"] === "cancelled" && $o["apiKey"] === null ? 0 : 1);' "$list" \
  && { pass=$((pass+1)); echo "ok   a cancelled server is shown as cancelled, and its key is no longer sent"; } || { fail=$((fail+1)); echo "FAIL cancelled: $list"; }
expect "the catalogue file is not served" 404 "http://127.0.0.1:$port/checkin/servers-catalogue.php"

# 24/7 Priority Support (Amgad, 24 Nov): the app's offer and plan, the checkout by lookup key, the
# webhook's plan, and each change reaching the Control Board as an order, even when it is down.
priority="http://127.0.0.1:$port/checkin/support/priority/"
pri_inst=6d7e8f90-0000-4000-8000-0000000000d1
pri_body() { echo "{\"customerId\":\"$1\",\"installId\":\"$pri_inst\",\"proof\":$2}"; }
orders="$work/board/orders.log"
expect "the support plan refuses GET" 405 "$priority"
expect "the support plan without proof is refused" 403 -X POST --data "$(pri_body demo-shop null)" "$priority"
expect "the support plan is not offered before activation" 400 -X POST --data "$(pri_body unverified null)" "$priority"
expect "the support plan with another customer's proof is refused" 403 -X POST --data "$(pri_body demo-clinic "$(profile_proof "$good")")" "$priority"
plan="$(curl -s -X POST --data "$(pri_body demo-shop "$(profile_proof "$good")")" "$priority")"
php -r '$d = json_decode($argv[1], true); exit($d["offer"]["monthlyCents"] === 10000 && $d["offer"]["vat"] === "excluded"
  && str_starts_with($d["offer"]["scope"]["en"], "24/7 support: response within 1 hour, around the clock, 7 days a week")
  && str_contains($d["offer"]["scope"]["el"], "1 ώρα") && $d["plan"] === null
  && $d["buyUrl"] === "https://blackark.example/checkin/buy/?customer=demo-shop&support=247" ? 0 : 1);' "$plan" \
  && { pass=$((pass+1)); echo "ok   the app gets the 24/7 offer (the offer's own words, EUR 100 excl. VAT), no plan yet, and the buy link"; } || { fail=$((fail+1)); echo "FAIL support plan offer: $plan"; }
got="$(location "$buy?customer=demo-shop&support=247")"
[[ "$got" == "303 https://checkout.stripe.com/c/pay/cs_test_fake" ]] && grep -q 'mode=subscription' <(last) \
  && grep -q 'line_items%5B0%5D%5Bprice%5D=price_sup247' <(last) && ! grep -q 'line_items%5B1%5D' <(last) \
  && grep -q 'metadata%5Bkind%5D=support_247' <(last) && grep -q 'subscription_data%5Bmetadata%5D%5Bkind%5D=support_247' <(last) \
  && grep -q 'billing_address_collection=required' <(last) && grep -q 'custom_fields%5B0%5D%5Bkey%5D=company' <(last) \
  && grep -q 'client_reference_id=demo-shop' <(last) && grep -q 'done%3Dsupport' <(last) \
  && { pass=$((pass+1)); echo "ok   24/7 support opens one subscription checkout on the price found by its lookup key, asking name, email and company"; } \
  || { fail=$((fail+1)); echo "FAIL support checkout ($got): $(last)"; }
touch "$work/fake/support_drift"
expect "a 24/7 price that differs from the offer is never charged" 503 "$buy?customer=demo-shop&support=247"
rm -f "$work/fake/support_drift"
branded "the 24/7 support thank-you page" "$buy?done=support"

sup_checkout='{"id":"evt_sup_1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_support001","client_reference_id":"demo-shop","customer":"cus_7","subscription":"sub_sup_1","payment_status":"paid","customer_details":{"name":"Maria Papadopoulou","email":"maria@shop.example"},"custom_fields":[{"key":"company","text":{"value":"Demo Shop IKE"}}],"metadata":{"kind":"support_247","customer_id":"demo-shop"}}}}'
[[ "$(send_event "$sup_checkout")" == 200 ]] && [[ "$(send_event "$sup_checkout")" == 200 ]] || { fail=$((fail+1)); echo "FAIL support checkout event"; }
php -r '$lines = array_values(array_filter(explode("\n", file_get_contents($argv[1]))));
  $o = json_decode($lines[0], true);
  exit(count($lines) === 1 && $o["kind"] === "support_247" && $o["event"] === "started" && $o["customerId"] === "demo-shop"
    && $o["subscriptionId"] === "sub_sup_1" && $o["status"] === "active" && $o["name"] === "Maria Papadopoulou"
    && $o["company"] === "Demo Shop IKE" && $o["email"] === "maria@shop.example" && is_string($o["startedAt"]) && isset($o["licence"]) ? 0 : 1);' "$orders" \
  && { pass=$((pass+1)); echo "ok   a paid 24/7 order reaches the board once, signed, with name, company, email, licence, subscription, start and status"; } || { fail=$((fail+1)); echo "FAIL support order to board: $(cat "$orders" 2>/dev/null)"; }
[[ "$(php -r '$d = new PDO("sqlite:" . $argv[1]); echo $d->query("SELECT status FROM support_plans WHERE subscription_id = '"'"'sub_sup_1'"'"'")->fetchColumn(), " ", $d->query("SELECT COUNT(*) FROM licenses WHERE subscription_id = '"'"'sub_sup_1'"'"'")->fetchColumn(), " ", implode(",", array_column($d->query("PRAGMA table_info(support_plans)")->fetchAll(), "name"));' "$db")" == "active 0 subscription_id,customer_id,status,session_id,started_at,paid_until,updated_at" ]] \
  && { pass=$((pass+1)); echo "ok   blackark.uk keeps the plan, never as a licence, and never the name, email or company"; } || { fail=$((fail+1)); echo "FAIL support plan row"; }
plan="$(curl -s -X POST --data "$(pri_body demo-shop "$(profile_proof "$good")")" "$priority")"
php -r 'exit(json_decode($argv[1], true)["plan"]["status"] === "active" ? 0 : 1);' "$plan" \
  && { pass=$((pass+1)); echo "ok   the app shows 24/7 support as active"; } || { fail=$((fail+1)); echo "FAIL plan active: $plan"; }
send_event '{"id":"evt_sup_2","type":"invoice.payment_failed","data":{"object":{"subscription":"sub_sup_1"}}}' >/dev/null
plan="$(curl -s -X POST --data "$(pri_body demo-shop "$(profile_proof "$good")")" "$priority")"
php -r 'exit(json_decode($argv[1], true)["plan"]["status"] === "past_due" ? 0 : 1);' "$plan" && grep -q '"event":"payment_failed"' "$orders" \
  && { pass=$((pass+1)); echo "ok   a failed renewal shows as past due in the app and updates the board's order"; } || { fail=$((fail+1)); echo "FAIL past_due: $plan"; }
touch "$work/board/board_down"
sup_end=$(( $(date +%s) + 31*86400 ))
send_event '{"id":"evt_sup_3","type":"invoice.paid","data":{"object":{"subscription":"sub_sup_1","lines":{"data":[{"price":{"id":"price_sup247"},"quantity":1,"period":{"end":'"$sup_end"'}}]}}}}' >/dev/null
waiting="$(php -r '$d = new PDO("sqlite:" . $argv[1]); echo $d->query("SELECT COUNT(*) FROM board_outbox")->fetchColumn();' "$db")"
rm -f "$work/board/board_down"
plan="$(curl -s -X POST --data "$(pri_body demo-shop "$(profile_proof "$good")")" "$priority")"
[[ "$waiting" == 1 ]] && grep -q '"event":"renewed"' "$orders" \
  && [[ "$(php -r '$d = new PDO("sqlite:" . $argv[1]); echo $d->query("SELECT COUNT(*) FROM board_outbox")->fetchColumn();' "$db")" == 0 ]] \
  && php -r '$p = json_decode($argv[1], true)["plan"]; exit($p["status"] === "active" && $p["paidUntil"] !== null ? 0 : 1);' "$plan" \
  && { pass=$((pass+1)); echo "ok   when the board is down the renewal waits, and reaches it on the next call; paid again, the plan is active"; } || { fail=$((fail+1)); echo "FAIL outbox: waiting=$waiting $plan"; }
send_event '{"id":"evt_sup_4","type":"customer.subscription.deleted","data":{"object":{"id":"sub_sup_1","metadata":{"kind":"support_247"}}}}' >/dev/null
plan="$(curl -s -X POST --data "$(pri_body demo-shop "$(profile_proof "$good")")" "$priority")"
php -r 'exit(json_decode($argv[1], true)["plan"]["status"] === "cancelled" ? 0 : 1);' "$plan" && grep -q '"event":"cancelled"' "$orders" \
  && { pass=$((pass+1)); echo "ok   a cancelled plan shows as inactive in the app and closes the loop on the board's order"; } || { fail=$((fail+1)); echo "FAIL cancelled plan: $plan"; }
other_plan="$(curl -s -X POST --data '{"customerId":"demo-clinic","installId":"'"$pri_inst"'","proof":'"$(profile_proof "$other")"'}' "$priority")"
php -r 'exit(json_decode($argv[1], true)["plan"] === null ? 0 : 1);' "$other_plan" \
  && { pass=$((pass+1)); echo "ok   another customer never sees it"; } || { fail=$((fail+1)); echo "FAIL other customer plan: $other_plan"; }

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
