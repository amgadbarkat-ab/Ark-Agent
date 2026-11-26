<?php
/**
 * https://blackark.uk/checkin/buy/link/ — the app's "Buy a licence" link (v0.1.57; the independent
 * assessment of 26 Nov, F1).
 *
 * POST {customerId, installId, proof, phone?: true}, the same install proof as renew/ and servers/
 * (lib.php, ark_install_proof_ok). An ended trial is still proof: that is who buys. Answers
 * {"buyUrl": "https://blackark.uk/checkin/buy/?customer=…&e=…&t=…[&phone=1]"}, a link that works for
 * ARK_BUY_LINK_SECONDS. Anything without proof: 403. 503 while blackark.uk has no `buy_link_secret`
 * or cannot check signatures, so the app falls back to the unsigned link.
 *
 * At most `buy_link_per_install_per_hour` (default 30) and `buy_link_per_address_per_hour` (default
 * 120) requests an hour.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__, 2) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function link_answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo $body ? json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    link_answer(405);
}
$raw = (string) file_get_contents('php://input', false, null, 0, 65537);
$body = strlen($raw) > 65536 ? null : json_decode($raw, true);
if (!is_array($body)) {
    link_answer(400);
}
$customer = (string) ($body['customerId'] ?? '');
$install = (string) ($body['installId'] ?? '');
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || $customer === 'unverified') {
    link_answer(400);
}
if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1) {
    link_answer(403);
}
if (ark_buy_link_secret() === null) {
    link_answer(503);
}
$db = ark_db();
if (!ark_request_allowed($db, 'buy_link', $install, (int) ark_config('buy_link_per_install_per_hour', 30), (int) ark_config('buy_link_per_address_per_hour', 120))) {
    link_answer(429);
}
$ok = ark_install_proof_ok($body['proof'] ?? null, $customer);
if ($ok === null) {
    link_answer(503);
}
if ($ok !== true) {
    link_answer(403);
}
link_answer(200, ['buyUrl' => ark_buy_url($customer, ($body['phone'] ?? false) === true ? '&phone=1' : '')]);
