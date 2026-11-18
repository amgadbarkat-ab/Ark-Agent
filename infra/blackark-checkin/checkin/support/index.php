<?php
/**
 * https://blackark.uk/checkin/support/ — the app's Help & support (#149, Amgad 18 Nov 2026).
 *
 * The app posts a support request here. This server:
 *  1. checks that it comes from a real install of this customer: the install's BlackArk-signed trial
 *     profile (as for check-ins), or its signed activation code or licence key (`ARK1-`, checked
 *     against the trial or licence public key in config.php);
 *  2. limits each install to 10 requests a day;
 *  3. looks up the customer's plan: paid while an active licence is on file, otherwise trial;
 *  4. forwards the request to the Control Board (`intake_url`), signed with `intake_secret`
 *     (X-Ark-Time, X-Ark-Nonce, X-Ark-Signature = HMAC-SHA256 of "<time>.<nonce>.<body>"), and
 *     answers the board's case number.
 * If the board cannot be reached it answers 502, and the app keeps the request and sends it again
 * later; the app's request id makes the board give back the same case, never a second one.
 *
 * Nothing is stored here but the install id and the time, for the daily limit. The request itself
 * (the customer's words and, if they chose, diagnostics) passes through to the board only.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

const SUPPORT_MAX_BODY = 1048576; // the signed profile can be large; the request itself is capped below
const SUPPORT_PER_INSTALL_PER_DAY = 10;

/** The first `$chars` characters of UTF-8 text (no mbstring needed). */
function support_cut(string $text, int $chars): string
{
    return preg_match('/^.{0,' . $chars . '}/su', $text, $match) === 1 ? $match[0] : '';
}

function support_answer(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/** An `ARK1-` code's payload (base64url JSON) and signature, checked against the right key. */
function support_code_ok($proof, string $customerId): ?bool
{
    if (!is_array($proof) || !is_string($proof['payload'] ?? null) || !is_string($proof['signature'] ?? null)) {
        return false;
    }
    if (!function_exists('sodium_crypto_sign_verify_detached')) {
        return null;
    }
    $json = ark_base64url_decode($proof['payload']);
    $code = $json === false ? null : json_decode($json, true);
    if (!is_array($code) || ($code['customer'] ?? null) !== $customerId) {
        return false;
    }
    $signature = ark_base64url_decode($proof['signature']);
    if ($signature === false || strlen($signature) !== 64) {
        return false;
    }
    $keys = ($code['action'] ?? '') === 'license'
        ? [(string) ark_config('license_public_key', '')]
        : (array) ark_config('trial_public_keys', []);
    foreach ($keys as $encoded) {
        $key = base64_decode((string) $encoded, true);
        if ($key !== false && strlen($key) === 32 && sodium_crypto_sign_verify_detached($signature, $proof['payload'], $key)) {
            return true;
        }
    }
    return false;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    support_answer(405, ['error' => 'POST only.']);
}
$intakeUrl = (string) ark_config('intake_url', '');
$secret = (string) ark_config('intake_secret', '');
if ($intakeUrl === '' || strlen($secret) < 32) {
    support_answer(503, ['error' => 'Support is not set up yet.']);
}
$raw = (string) file_get_contents('php://input', false, null, 0, SUPPORT_MAX_BODY + 1);
if (strlen($raw) > SUPPORT_MAX_BODY) {
    support_answer(413, ['error' => 'Too large.']);
}
$in = json_decode($raw, true);
if (!is_array($in)) {
    support_answer(400, ['error' => 'Not JSON.']);
}
$text = function (string $key, int $max) use ($in): ?string {
    $value = $in[$key] ?? null;
    return is_string($value) && trim($value) !== '' && strlen($value) <= $max ? trim($value) : null;
};
$customer = (string) ($in['customerId'] ?? '');
$install = (string) ($in['installId'] ?? '');
$requestId = (string) ($in['requestId'] ?? '');
if (
    preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 ||
    preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1 ||
    preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $requestId) !== 1 ||
    $text('appVersion', 32) === null || $text('subject', 600) === null || $text('message', 24000) === null ||
    !in_array($in['language'] ?? null, ['el', 'en'], true) || !is_bool($in['urgent'] ?? null)
) {
    support_answer(400, ['error' => 'Not a support request.']);
}

$proof = $in['proof'] ?? null;
$kind = is_array($proof) ? ($proof['kind'] ?? '') : '';
$ok = $kind === 'profile' ? ark_proof_ok($proof, $customer) : ($kind === 'code' ? support_code_ok($proof, $customer) : false);
if ($ok === null) {
    support_answer(503, ['error' => 'This server cannot check signatures.']);
}
if ($ok !== true) {
    support_answer(403, ['error' => 'Not signed for this customer.']);
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS support_requests (install_id TEXT NOT NULL, request_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (install_id, request_id))');
$db->prepare('DELETE FROM support_requests WHERE at < ?')->execute([time() - 86400]);
$count = $db->prepare('SELECT COUNT(*) FROM support_requests WHERE install_id = ? AND request_id <> ?');
$count->execute([$install, $requestId]);
if ((int) $count->fetchColumn() >= SUPPORT_PER_INSTALL_PER_DAY) {
    support_answer(429, ['error' => 'Too many requests today.']);
}
$db->prepare('INSERT OR IGNORE INTO support_requests (install_id, request_id, at) VALUES (?, ?, ?)')->execute([$install, $requestId, time()]);

$licence = $db->prepare("SELECT 1 FROM licenses WHERE customer_id = ? AND status = 'active' AND (valid_until IS NULL OR valid_until > ?) LIMIT 1");
$licence->execute([$customer, ark_now()]);
$plan = $licence->fetchColumn() ? 'paid' : 'trial';

$diagnostics = $in['diagnostics'] ?? null;
$forward = json_encode([
    'requestId' => $requestId,
    'customerId' => $customer,
    'installId' => $install,
    'appVersion' => $text('appVersion', 32),
    'language' => $in['language'],
    'subject' => support_cut((string) $text('subject', 600), 200),
    'message' => support_cut((string) $text('message', 24000), 8000),
    'urgent' => $in['urgent'],
    'plan' => $plan,
    'diagnostics' => is_array($diagnostics) ? $diagnostics : null,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

$time = (string) time();
$nonce = ark_base64url(random_bytes(18));
$context = stream_context_create(['http' => [
    'method' => 'POST',
    'header' => "Content-Type: application/json\r\nX-Ark-Time: $time\r\nX-Ark-Nonce: $nonce\r\nX-Ark-Signature: "
        . hash_hmac('sha256', $time . '.' . $nonce . '.' . $forward, $secret) . "\r\n",
    'content' => $forward,
    'timeout' => 15,
    'ignore_errors' => true,
]]);
$answer = @file_get_contents($intakeUrl, false, $context);
$headers = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
$status = 0;
foreach ($headers as $line) {
    if (preg_match('#^HTTP/\S+ (\d{3})#', $line, $match) === 1) {
        $status = (int) $match[1];
    }
}
$body = is_string($answer) ? json_decode($answer, true) : null;
if (($status === 200 || $status === 201) && is_array($body) && is_int($body['case'] ?? null)) {
    support_answer(200, ['case' => $body['case']]);
}
if ($status === 400 || $status === 429) {
    // The board refused this request itself; sending it again would not help.
    support_answer($status, ['error' => $status === 429 ? 'Too many requests today.' : 'Not a support request.']);
}
error_log('ark-support: the board did not take a request (HTTP ' . $status . ')');
support_answer(502, ['error' => 'Support could not be reached. The app will send it again.']);
