<?php
/**
 * https://blackark.uk/checkin/servers/ — Ark Private Server for the app (#149, 19 Nov).
 *
 * POST {customerId, installId, proof}, the same install proof as renew/ and support/ (lib.php,
 * ark_install_proof_ok). Answers:
 *   {"tiers": [...], "order": null | {...}, "buyUrl": "https://blackark.uk/checkin/buy/?customer=…&server="}
 * `tiers` is servers-catalogue.php as the app shows it. `order` is this customer's latest order:
 * its tier and status (setting_up, ready, stopped, cancelled), when it was ordered and paid to, and,
 * once BlackArk has set it up, the address, the model and the key to reach it. Only to the install
 * itself, because the key is in it. Anything without proof: 403.
 *
 * At most `servers_per_install_per_hour` requests (default 60) from one install in an hour.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function servers_answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo $body ? json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    servers_answer(405);
}
$raw = (string) file_get_contents('php://input', false, null, 0, 1048577);
$body = strlen($raw) > 1048576 ? null : json_decode($raw, true);
if (!is_array($body)) {
    servers_answer(400);
}
$customer = (string) ($body['customerId'] ?? '');
$install = (string) ($body['installId'] ?? '');
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1) {
    servers_answer(400);
}
if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1) {
    servers_answer(403);
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS servers_requests (install_id TEXT NOT NULL, at INTEGER NOT NULL)');
$db->prepare('DELETE FROM servers_requests WHERE at < ?')->execute([time() - 3600]);
$count = $db->prepare('SELECT COUNT(*) FROM servers_requests WHERE install_id = ?');
$count->execute([$install]);
if ((int) $count->fetchColumn() >= (int) ark_config('servers_per_install_per_hour', 60)) {
    servers_answer(429);
}
$db->prepare('INSERT INTO servers_requests (install_id, at) VALUES (?, ?)')->execute([$install, time()]);

$ok = ark_install_proof_ok($body['proof'] ?? null, $customer);
if ($ok === null) {
    servers_answer(503);
}
if ($ok !== true) {
    servers_answer(403);
}

$tiers = [];
foreach (ark_server_catalogue() as $id => $entry) {
    $tiers[] = [
        'id' => $id,
        'name' => $entry['name'],
        'cpu' => $entry['cpu'],
        'memory' => $entry['memory'],
        'gpu' => $entry['gpu'],
        'storage' => $entry['storage'],
        'modelSize' => $entry['modelSize'],
        'models' => $entry['models'],
        'monthlyCents' => $entry['monthlyCents'],
        'activationCents' => $entry['activationCents'],
    ];
}

ark_private_servers_table($db);
$find = $db->prepare('SELECT * FROM private_servers WHERE customer_id = ? ORDER BY ordered_at DESC LIMIT 1');
$find->execute([$customer]);
$row = $find->fetch() ?: null;
$order = null;
if ($row) {
    $ready = $row['status'] === 'ready';
    $order = [
        'tier' => $row['tier'],
        'status' => $row['status'],
        'orderedAt' => gmdate('c', (int) $row['ordered_at']),
        'paidUntil' => $row['paid_until'] ? gmdate('c', (int) $row['paid_until']) : null,
        'readyAt' => $ready && $row['ready_at'] ? gmdate('c', (int) $row['ready_at']) : null,
        'baseUrl' => $ready ? $row['base_url'] : null,
        'model' => $ready ? $row['model'] : null,
        'apiKey' => $ready ? $row['api_key'] : null,
    ];
}
$base = rtrim((string) ark_config('public_base_url', 'https://blackark.uk/checkin'), '/');
servers_answer(200, [
    'tiers' => $tiers,
    'order' => $order,
    'buyUrl' => $base . '/buy/?customer=' . rawurlencode($customer) . '&server=',
]);
