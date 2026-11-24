<?php
/**
 * https://blackark.uk/checkin/support/priority/ — 24/7 Priority Support for the app (Amgad, 24 Nov 2026).
 *
 * POST {customerId, installId, proof}, the same install proof as servers/ and support/ (lib.php,
 * ark_install_proof_ok). Answers:
 *   {"offer": {...}, "plan": null | {"status", "startedAt", "paidUntil"}, "buyUrl": "https://…/buy/?customer=…&support=247"}
 * `offer` is the price and scope as the app shows them (lib.php, ark_support_247_offer). `plan` is this
 * customer's latest 24/7 support subscription: active, past_due (a renewal failed) or cancelled.
 * Anything without proof: 403. At most `servers_per_install_per_hour` requests (default 60) from one
 * install in an hour. It also delivers anything waiting for the Control Board (lib.php, ark_board_flush).
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__, 2) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function priority_answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo $body ? json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    priority_answer(405);
}
$raw = (string) file_get_contents('php://input', false, null, 0, 1048577);
$body = strlen($raw) > 1048576 ? null : json_decode($raw, true);
if (!is_array($body)) {
    priority_answer(400);
}
$customer = (string) ($body['customerId'] ?? '');
$install = (string) ($body['installId'] ?? '');
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || $customer === 'unverified') {
    priority_answer(400);
}
if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1) {
    priority_answer(403);
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS priority_requests (install_id TEXT NOT NULL, at INTEGER NOT NULL)');
$db->prepare('DELETE FROM priority_requests WHERE at < ?')->execute([time() - 3600]);
$count = $db->prepare('SELECT COUNT(*) FROM priority_requests WHERE install_id = ?');
$count->execute([$install]);
if ((int) $count->fetchColumn() >= (int) ark_config('servers_per_install_per_hour', 60)) {
    priority_answer(429);
}
$db->prepare('INSERT INTO priority_requests (install_id, at) VALUES (?, ?)')->execute([$install, time()]);

$ok = ark_install_proof_ok($body['proof'] ?? null, $customer);
if ($ok === null) {
    priority_answer(503);
}
if ($ok !== true) {
    priority_answer(403);
}

ark_board_flush($db, 5);
$base = rtrim((string) ark_config('public_base_url', 'https://blackark.uk/checkin'), '/');
priority_answer(200, [
    'offer' => ark_support_247_offer(),
    'plan' => ark_support_plan_view($db, $customer),
    'buyUrl' => $base . '/buy/?customer=' . rawurlencode($customer) . '&support=247',
]);
