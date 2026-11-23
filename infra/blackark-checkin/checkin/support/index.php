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
 *  BEFORE ACTIVATION (Amgad, 23 Nov 2026): an install with no trial file, code or licence yet can
 *  still ask for help. It sends `customerId` "unverified" and no proof. Nothing says whose install
 *  it is, so it is limited to 3 a day per install and 3 a day per address, forwarded as customer
 *  "unverified" with plan "none", and may carry an email address the person chose to give;
 *  4. forwards the request to the Control Board (`intake_url`), signed with `intake_secret`
 *     (X-Ark-Time, X-Ark-Nonce, X-Ark-Signature = HMAC-SHA256 of "<time>.<nonce>.<body>"), and
 *     answers the board's case number.
 * If the board cannot be reached it answers 502, and the app keeps the request and sends it again
 * later; the app's request id makes the board give back the same case, never a second one.
 *
 * Nothing is stored here but the install id and the time, for the daily limit, and for a request
 * before activation a keyed hash of the sender's address (never the address). The request itself
 * (the customer's words, the contact address and, if they chose, diagnostics) passes through to the
 * board only.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

const SUPPORT_MAX_BODY = 1048576; // the signed profile can be large; the request itself is capped below
const SUPPORT_PER_INSTALL_PER_DAY = 10;
const SUPPORT_UNVERIFIED_PER_DAY = 3; // per install, and separately per address
const SUPPORT_UNVERIFIED = 'unverified';

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
$unverified = $customer === SUPPORT_UNVERIFIED && ($in['proof'] ?? null) === null;
$contact = $in['contactEmail'] ?? null;
if (
    preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 ||
    // Only a request with no proof is unverified, and only it may carry a contact address.
    ($customer === SUPPORT_UNVERIFIED && !$unverified) ||
    ($contact !== null && (!$unverified || !is_string($contact) || strlen($contact) > 254
        || filter_var($contact, FILTER_VALIDATE_EMAIL) === false)) ||
    preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1 ||
    preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $requestId) !== 1 ||
    $text('appVersion', 32) === null || $text('subject', 600) === null || $text('message', 24000) === null ||
    !in_array($in['language'] ?? null, ['el', 'en'], true) || !is_bool($in['urgent'] ?? null)
) {
    support_answer(400, ['error' => 'Not a support request.']);
}

$db = ark_db();
if ($unverified) {
    // Keyed, so the table never holds an address that could be read back.
    $from = hash_hmac('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? ''), $secret);
    $db->exec('CREATE TABLE IF NOT EXISTS support_unverified (install_id TEXT NOT NULL, request_id TEXT NOT NULL, address_hash TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (install_id, request_id))');
    $db->prepare('DELETE FROM support_unverified WHERE at < ?')->execute([time() - 86400]);
    $seen = $db->prepare('SELECT (SELECT COUNT(*) FROM support_unverified WHERE install_id = ? AND request_id <> ?), (SELECT COUNT(*) FROM support_unverified WHERE address_hash = ? AND request_id <> ?)');
    $seen->execute([$install, $requestId, $from, $requestId]);
    [$byInstall, $byAddress] = $seen->fetch(PDO::FETCH_NUM);
    if ((int) $byInstall >= SUPPORT_UNVERIFIED_PER_DAY || (int) $byAddress >= SUPPORT_UNVERIFIED_PER_DAY) {
        support_answer(429, ['error' => 'Too many requests today.']);
    }
    $db->prepare('INSERT OR IGNORE INTO support_unverified (install_id, request_id, address_hash, at) VALUES (?, ?, ?, ?)')->execute([$install, $requestId, $from, time()]);
    $plan = 'none';
} else {
    $ok = ark_install_proof_ok($in['proof'] ?? null, $customer);
    if ($ok === null) {
        support_answer(503, ['error' => 'This server cannot check signatures.']);
    }
    if ($ok !== true) {
        support_answer(403, ['error' => 'Not signed for this customer.']);
    }

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
}

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
] + ($unverified ? ['contactEmail' => is_string($contact) ? $contact : null] : []), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

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
