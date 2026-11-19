<?php
/**
 * https://blackark.uk/checkin/export/ — the read-only export for the BlackArk Control Board (#149).
 *
 * Only the board calls this. It reads; it never changes a check-in, a licence or a balance.
 *
 * THE REQUEST. POST, a JSON body of at most 1 KB (today `{"want":"export"}`), and three headers:
 *   X-Ark-Time       the Unix time, within 5 minutes of this server's clock;
 *   X-Ark-Nonce      16 to 64 characters of [A-Za-z0-9_-], new for every request;
 *   X-Ark-Signature  the hex HMAC-SHA256 of "<time>.<nonce>.<body>" with `export_secret`.
 * A nonce is taken once: the same signed request sent again is refused (409), so a copied request
 * cannot be replayed inside the 5 minutes.
 *
 * THE ANSWER. JSON, signed the same way back (X-Ark-Time, and X-Ark-Signature over
 * "<time>.<the request's nonce>.<answer>"), so the board knows it came from here, for its request:
 *   installs  per install: customer id, random install id, version, trial/ended/paid, days left,
 *             end date, the trial employee count, whether the proof was verified, first and last
 *             check-in, the number of check-ins, and (from v0.1.49) the counts: people, people
 *             active in 7 days, conversations in 7 days, phone line yes/no, and the system;
 *   licences  per subscription: customer id, plan, seats, add-ons, active/canceled, period end,
 *             valid until, updated;
 *   phone     per customer: the balance in mils, its state (ok/low/empty), whether automatic
 *             top-up was chosen, updated;
 *   ledger    the last 90 days of credits and charges: customer id, kind, minutes, mils, anything
 *             written off, when.
 * Never in it: an IP address (none is kept), a name, an email, a billing country, a licence key, a
 * Stripe id, or a ledger reference (a Twilio call id).
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function export_refuse(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    export_refuse(405, 'POST only.');
}
$secret = (string) ark_config('export_secret', '');
if (strlen($secret) < 32) {
    export_refuse(503, 'Not configured.');
}
$body = (string) file_get_contents('php://input', false, null, 0, 1025);
if (strlen($body) > 1024) {
    export_refuse(413, 'Too large.');
}
$time = (string) ($_SERVER['HTTP_X_ARK_TIME'] ?? '');
$nonce = (string) ($_SERVER['HTTP_X_ARK_NONCE'] ?? '');
$signature = (string) ($_SERVER['HTTP_X_ARK_SIGNATURE'] ?? '');
if (
    preg_match('/^\d{1,12}$/', $time) !== 1 ||
    preg_match('/^[A-Za-z0-9_-]{16,64}$/', $nonce) !== 1 ||
    !hash_equals(hash_hmac('sha256', $time . '.' . $nonce . '.' . $body, $secret), $signature)
) {
    export_refuse(403, 'Bad signature.');
}
if (abs(time() - (int) $time) > 300) {
    export_refuse(403, 'Stale request.');
}
$request = json_decode($body, true);
if (!is_array($request) || ($request['want'] ?? '') !== 'export') {
    export_refuse(400, 'Unknown request.');
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS export_nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)');
$db->prepare('DELETE FROM export_nonces WHERE at < ?')->execute([time() - 900]);
$take = $db->prepare('INSERT OR IGNORE INTO export_nonces (nonce, at) VALUES (?, ?)');
$take->execute([$nonce, time()]);
if ($take->rowCount() === 0) {
    export_refuse(409, 'Already used.');
}

$installs = [];
foreach ($db->query('SELECT customer_id, install_id, version, status, days_left, ends_at, employees, verified, first_seen, last_seen, checkins, people, active_people_7d, conversations_7d, phone_line, os FROM installs ORDER BY customer_id, last_seen DESC LIMIT 5000') as $row) {
    $installs[] = [
        'customerId' => (string) $row['customer_id'],
        'installId' => (string) $row['install_id'],
        'version' => (string) $row['version'],
        'status' => (string) $row['status'],
        'daysLeft' => (int) $row['days_left'],
        'endsAt' => $row['ends_at'] === null ? null : (string) $row['ends_at'],
        'employees' => $row['employees'] === null ? null : (int) $row['employees'],
        'verified' => (int) $row['verified'] === 1,
        'firstSeen' => (string) $row['first_seen'],
        'lastSeen' => (string) $row['last_seen'],
        'checkins' => (int) $row['checkins'],
        'people' => $row['people'] === null ? null : (int) $row['people'],
        'activePeople7d' => $row['active_people_7d'] === null ? null : (int) $row['active_people_7d'],
        'conversations7d' => $row['conversations_7d'] === null ? null : (int) $row['conversations_7d'],
        'phoneLine' => $row['phone_line'] === null ? null : (int) $row['phone_line'] === 1,
        'os' => $row['os'] === null ? null : (string) $row['os'],
    ];
}

$licences = [];
foreach ($db->query('SELECT customer_id, plan, seats, addons, status, period_end, valid_until, updated_at FROM licenses ORDER BY customer_id, updated_at DESC LIMIT 5000') as $row) {
    $licences[] = [
        'customerId' => $row['customer_id'] === null ? null : (string) $row['customer_id'],
        'plan' => $row['plan'] === null ? null : (string) $row['plan'],
        'seats' => $row['seats'] === null ? null : (int) $row['seats'],
        'addons' => $row['addons'] ? explode(',', (string) $row['addons']) : [],
        'status' => (string) $row['status'],
        'periodEnd' => $row['period_end'] ? gmdate('Y-m-d\TH:i:s\Z', (int) $row['period_end']) : null,
        'validUntil' => $row['valid_until'] === null ? null : (string) $row['valid_until'],
        'updatedAt' => (string) $row['updated_at'],
    ];
}

$phone = [];
foreach ($db->query('SELECT customer_id, balance_mils, auto_topup, updated_at FROM phone_accounts ORDER BY customer_id LIMIT 5000') as $row) {
    $phone[] = [
        'customerId' => (string) $row['customer_id'],
        'balanceMils' => (int) $row['balance_mils'],
        'state' => ark_phone_state((int) $row['balance_mils']),
        'autoTopup' => (int) $row['auto_topup'] === 1,
        'updatedAt' => (string) $row['updated_at'],
    ];
}

$ledger = [];
$since = gmdate('Y-m-d\TH:i:s\Z', time() - 90 * 86400);
$recent = $db->prepare('SELECT customer_id, kind, minutes, mils, written_off_mils, at FROM phone_ledger WHERE at >= ? ORDER BY id DESC LIMIT 5000');
$recent->execute([$since]);
foreach ($recent as $row) {
    $ledger[] = [
        'customerId' => (string) $row['customer_id'],
        'kind' => (string) $row['kind'],
        'minutes' => (int) $row['minutes'],
        'mils' => (int) $row['mils'],
        'writtenOffMils' => (int) $row['written_off_mils'],
        'at' => (string) $row['at'],
    ];
}

$answer = json_encode([
    'v' => 1,
    'generatedAt' => ark_now(),
    'installs' => $installs,
    'licences' => $licences,
    'phone' => $phone,
    'ledger' => $ledger,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
$answeredAt = (string) time();
header('X-Ark-Time: ' . $answeredAt);
header('X-Ark-Signature: ' . hash_hmac('sha256', $answeredAt . '.' . $nonce . '.' . $answer, $secret));
echo $answer;
