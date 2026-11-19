<?php
/**
 * https://blackark.uk/checkin/renew/ — where an install asks for its licence key (#109, v0.1.44;
 * v0.1.49: also before it has one, so a payment reaches the app with nothing typed).
 *
 * The app sends {customerId, installId, version, validUntil, proof}. `validUntil` is the end of the
 * licence key it has, or null when it has none (a trial, or an install waiting on Activate). If this
 * customer's active subscription has a key that lasts longer, it is returned as {"key": "ARK1-…"},
 * exactly as the webhook signed it; otherwise {}.
 *
 * ONLY TO THE INSTALL ITSELF (v0.1.49). A customer id is not a secret, so it is not enough: the
 * request must carry the install's proof, checked as Help & support checks it (lib.php,
 * ark_install_proof_ok): its BlackArk-signed trial profile, or its signed activation code or licence
 * key, made for this customer. An install from v0.1.44 to v0.1.48 sends no proof but its key's number
 * (`nonce`); the number of a key issued to this customer is accepted as its proof. Anything else: 403.
 *
 * At most `renew_per_install_per_hour` requests (default 150) from one install in an hour, refused or
 * not: the app asks every 20 seconds for half an hour after the buy page opens, and every few minutes
 * otherwise. Kept: the install id and the time of each request, for an hour. Nothing else.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function renew_answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo $body ? json_encode($body, JSON_UNESCAPED_SLASHES) : '{}';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    renew_answer(405);
}
// The signed trial profile can be large, as for Help & support.
$raw = (string) file_get_contents('php://input', false, null, 0, 1048577);
$body = strlen($raw) > 1048576 ? null : json_decode($raw, true);
if (!is_array($body)) {
    renew_answer(400);
}
$customer = (string) ($body['customerId'] ?? '');
$install = (string) ($body['installId'] ?? '');
$validUntil = $body['validUntil'] ?? null;
$has = $validUntil === null ? 0 : (is_string($validUntil) ? strtotime($validUntil) : false);
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || $has === false) {
    renew_answer(400);
}
// No install id: nothing proves which install is asking, so it is refused as any unproven request is
// (DT Lab, #109, 19 Nov: a request with no proof and no install id answered 400, the notes say 403).
if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1) {
    renew_answer(403);
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS renew_requests (install_id TEXT NOT NULL, at INTEGER NOT NULL)');
$db->exec('CREATE INDEX IF NOT EXISTS renew_requests_install ON renew_requests (install_id, at)');
$db->prepare('DELETE FROM renew_requests WHERE at < ?')->execute([time() - 3600]);
$count = $db->prepare('SELECT COUNT(*) FROM renew_requests WHERE install_id = ?');
$count->execute([$install]);
if ((int) $count->fetchColumn() >= (int) ark_config('renew_per_install_per_hour', 150)) {
    renew_answer(429);
}
$db->prepare('INSERT INTO renew_requests (install_id, at) VALUES (?, ?)')->execute([$install, time()]);

$proof = $body['proof'] ?? null;
if ($proof === null && is_string($body['nonce'] ?? null)) {
    $ok = ark_issued_nonce_ok($db, $customer, $body['nonce']);
} else {
    $ok = ark_install_proof_ok($proof, $customer);
}
if ($ok === null) {
    renew_answer(503);
}
if ($ok !== true) {
    renew_answer(403);
}

$find = $db->prepare("SELECT license_key, valid_until FROM licenses WHERE customer_id = ? AND status = 'active' AND license_key IS NOT NULL ORDER BY valid_until DESC LIMIT 1");
$find->execute([$customer]);
$row = $find->fetch();
if ($row && strtotime((string) $row['valid_until']) > $has) {
    renew_answer(200, ['key' => $row['license_key']]);
}
// A tier switch or a seat change (v0.1.49) signs a new key for the same paid period: same end,
// another nonce. The install that sends the old nonce gets it.
$nonce = (string) ($body['nonce'] ?? '');
if ($row && $nonce !== '' && strtotime((string) $row['valid_until']) === $has) {
    $payload = json_decode((string) ark_base64url_decode(explode('.', substr((string) $row['license_key'], 5))[0]), true);
    if (is_array($payload) && ($payload['nonce'] ?? '') !== $nonce) {
        renew_answer(200, ['key' => $row['license_key']]);
    }
}
renew_answer(200);
