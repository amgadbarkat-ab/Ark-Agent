<?php
/**
 * POST https://blackark.uk/checkin/ — one install's daily trial check-in (#109).
 *
 * Body (JSON), exactly what ArkAgent v0.1.37 sends:
 *   customerId  lower-case letters, digits, hyphens (2–64)
 *   installId   a UUID, random per install
 *   version     the app version
 *   status      "trial" | "ended" | "paid"
 *   daysLeft    0–10000
 *   endsAt      ISO 8601 date-time (optional)
 *   employees   0–1000 (optional)
 * From v0.1.38 also:
 *   proof       { profile, signature }: the install's signed trial profile, checked here.
 *
 * Answers 204 when stored, 400 for anything else in the body, 403 when proof is required and
 * missing or wrong, 429 when the same install checked in moments ago.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require __DIR__ . '/lib.php';

ark_send_security_headers();

function ark_refuse(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    ark_refuse(405, 'Only POST.');
}

$length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($length > 700000) {
    ark_refuse(413, 'Too large.');
}
$raw = file_get_contents('php://input', false, null, 0, 700001);
if ($raw === false || strlen($raw) > 700000) {
    ark_refuse(413, 'Too large.');
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    ark_refuse(400, 'Not a check-in.');
}

$allowed = ['customerId', 'installId', 'version', 'status', 'daysLeft', 'endsAt', 'employees', 'proof'];
foreach (array_keys($body) as $key) {
    if (!in_array($key, $allowed, true)) {
        ark_refuse(400, 'Not a check-in.');
    }
}

$customerId = $body['customerId'] ?? null;
$installId = $body['installId'] ?? null;
$version = $body['version'] ?? null;
$status = $body['status'] ?? null;
$daysLeft = $body['daysLeft'] ?? null;
$endsAt = $body['endsAt'] ?? null;
$employees = $body['employees'] ?? null;

$valid =
    is_string($customerId) && preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customerId) === 1 &&
    is_string($installId) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $installId) === 1 &&
    is_string($version) && preg_match('/^[0-9A-Za-z.+-]{1,40}$/', $version) === 1 &&
    is_string($status) && in_array($status, ['trial', 'ended', 'paid'], true) &&
    is_int($daysLeft) && $daysLeft >= 0 && $daysLeft <= 10000 &&
    ($endsAt === null || (is_string($endsAt) && strlen($endsAt) <= 40 && strtotime($endsAt) !== false)) &&
    ($employees === null || (is_int($employees) && $employees >= 0 && $employees <= 1000));
if (!$valid) {
    ark_refuse(400, 'Not a check-in.');
}
$installId = strtolower($installId);

$verified = 0;
if (array_key_exists('proof', $body)) {
    $ok = ark_proof_ok($body['proof'], $customerId);
    if ($ok === false) {
        ark_refuse(403, 'The proof is not a BlackArk trial profile for this customer.');
    }
    $verified = $ok === true ? 1 : 0;
} elseif (ark_config('require_proof', false)) {
    ark_refuse(403, 'A signed trial profile is required.');
}

try {
    $db = ark_db();
    $db->beginTransaction();
    $find = $db->prepare('SELECT last_seen FROM installs WHERE install_id = ?');
    $find->execute([$installId]);
    $existing = $find->fetch();
    $now = ark_now();
    $minimumGap = (int) ark_config('rate_limit_seconds', 300);
    if ($existing && (time() - (int) strtotime($existing['last_seen'])) < $minimumGap) {
        $db->rollBack();
        header('Retry-After: ' . $minimumGap);
        ark_refuse(429, 'This install checked in a moment ago.');
    }
    if (!$existing) {
        $count = (int) $db->query('SELECT COUNT(*) FROM installs')->fetchColumn();
        if ($count >= (int) ark_config('max_installs', 2000)) {
            $db->rollBack();
            ark_refuse(429, 'This receiver is full.');
        }
        $insert = $db->prepare('INSERT INTO installs
            (install_id, customer_id, version, status, days_left, ends_at, employees, verified, first_seen, last_seen, checkins)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)');
        $insert->execute([$installId, $customerId, $version, $status, $daysLeft, $endsAt, $employees, $verified, $now, $now]);
    } else {
        $update = $db->prepare('UPDATE installs SET customer_id = ?, version = ?, status = ?, days_left = ?,
            ends_at = ?, employees = ?, verified = ?, last_seen = ?, checkins = checkins + 1 WHERE install_id = ?');
        $update->execute([$customerId, $version, $status, $daysLeft, $endsAt, $employees, $verified, $now, $installId]);
    }
    $db->commit();
} catch (Throwable $error) {
    error_log('ark-checkin: ' . $error->getMessage());
    ark_refuse(500, 'The check-in could not be stored.');
}

http_response_code(204);
