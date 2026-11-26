<?php
/**
 * https://blackark.uk/checkin/support/replies/ — BlackArk's replies, for the app's Help & support
 * (Gap 3, Amgad 23 Nov 2026, #149).
 *
 * The app posts its install id and the same proof it sends with a support request: the install's
 * BlackArk-signed trial profile, activation code or licence key. Before activation it sends
 * customer "unverified" and no proof. This server checks that exactly as `checkin/support/` does,
 * then asks the Control Board (`intake_replies_url`, or `intake_url` with /intake/app replaced by
 * /intake/replies), signed with `intake_secret` (X-Ark-Time, X-Ark-Nonce, X-Ark-Signature), for that
 * install's own cases and the replies to them, and passes back only those.
 *
 * Each install may ask 60 times an hour. Nothing is stored here but the install id and the time, for
 * that limit, for an hour; the internet address only as a keyed hash, for an hour, for a limit per address. The replies pass through; they are never
 * kept.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__, 2) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

const REPLIES_MAX_BODY = 1048576; // the signed profile can be large
const REPLIES_PER_INSTALL_PER_HOUR = 60;

function replies_answer(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    replies_answer(405, ['error' => 'POST only.']);
}
$intakeUrl = (string) ark_config('intake_url', '');
$repliesUrl = (string) ark_config('intake_replies_url', preg_replace('#/intake/app$#', '/intake/replies', $intakeUrl));
$secret = (string) ark_config('intake_secret', '');
if ($repliesUrl === '' || $repliesUrl === $intakeUrl || strlen($secret) < 32) {
    replies_answer(503, ['error' => 'Support is not set up yet.']);
}
$raw = (string) file_get_contents('php://input', false, null, 0, REPLIES_MAX_BODY + 1);
if (strlen($raw) > REPLIES_MAX_BODY) {
    replies_answer(413, ['error' => 'Too large.']);
}
$in = json_decode($raw, true);
if (!is_array($in)) {
    replies_answer(400, ['error' => 'Not JSON.']);
}
$customer = (string) ($in['customerId'] ?? '');
$install = (string) ($in['installId'] ?? '');
$unverified = $customer === 'unverified' && ($in['proof'] ?? null) === null;
if (
    preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 ||
    ($customer === 'unverified' && !$unverified) ||
    preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1
) {
    replies_answer(400, ['error' => 'Not a replies request.']);
}
// Per address first (v0.1.57), before any signature is checked: the install id is whatever the
// caller says. The address is kept only as a keyed hash, for an hour.
if (!ark_address_allowed(ark_db(), 'replies', (int) ark_config('replies_per_address_per_hour', 240))) {
    replies_answer(429, ['error' => 'Too many requests.']);
}
if (!$unverified) {
    $ok = ark_install_proof_ok($in['proof'] ?? null, $customer);
    if ($ok === null) {
        replies_answer(503, ['error' => 'This server cannot check signatures.']);
    }
    if ($ok !== true) {
        replies_answer(403, ['error' => 'Not signed for this customer.']);
    }
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS support_reply_reads (install_id TEXT NOT NULL, at INTEGER NOT NULL)');
$db->prepare('DELETE FROM support_reply_reads WHERE at < ?')->execute([time() - 3600]);
$seen = $db->prepare('SELECT COUNT(*) FROM support_reply_reads WHERE install_id = ?');
$seen->execute([$install]);
if ((int) $seen->fetchColumn() >= REPLIES_PER_INSTALL_PER_HOUR) {
    replies_answer(429, ['error' => 'Asked too often. Try again later.']);
}
$db->prepare('INSERT INTO support_reply_reads (install_id, at) VALUES (?, ?)')->execute([$install, time()]);

$forward = json_encode(['customerId' => $customer, 'installId' => $install], JSON_UNESCAPED_SLASHES);
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
$answer = @file_get_contents($repliesUrl, false, $context);
$headers = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
$status = 0;
foreach ($headers as $line) {
    if (preg_match('#^HTTP/\S+ (\d{3})#', $line, $match) === 1) {
        $status = (int) $match[1];
    }
}
$body = is_string($answer) ? json_decode($answer, true) : null;
if ($status !== 200 || !is_array($body) || !is_array($body['cases'] ?? null)) {
    error_log('ark-support-replies: the board did not answer (HTTP ' . $status . ')');
    replies_answer(502, ['error' => 'Support could not be reached. Try again later.']);
}

// Only the fields the app shows, in the shapes it expects.
$str = static fn ($value, int $max): ?string => is_string($value) && strlen($value) <= $max ? $value : null;
$cases = [];
foreach (array_slice($body['cases'], 0, 20) as $one) {
    if (!is_array($one) || !is_int($one['case'] ?? null) || !is_array($one['replies'] ?? null)) {
        continue;
    }
    $replies = [];
    foreach (array_slice($one['replies'], 0, 50) as $reply) {
        if (!is_array($reply) || $str($reply['text'] ?? null, 40000) === null || $str($reply['at'] ?? null, 40) === null) {
            continue;
        }
        $replies[] = [
            'at' => $reply['at'],
            'language' => ($reply['language'] ?? '') === 'el' ? 'el' : 'en',
            'text' => $reply['text'],
            'english' => $str($reply['english'] ?? null, 40000),
        ];
    }
    $cases[] = [
        'case' => $one['case'],
        'subject' => (string) ($str($one['subject'] ?? null, 1000) ?? ''),
        'status' => in_array($one['status'] ?? null, ['new', 'open', 'waiting', 'solved', 'closed'], true) ? $one['status'] : 'open',
        'openedAt' => (string) ($str($one['openedAt'] ?? null, 40) ?? ''),
        'replies' => $replies,
    ];
}
replies_answer(200, ['cases' => $cases]);
