<?php
/**
 * https://blackark.uk/checkin/renew/ — where an install asks once a day for its renewed licence
 * key (#109, v0.1.44). The app sends {customerId, installId, version, nonce, validUntil}. If this
 * customer's active subscription has a key that lasts longer than the one the install has, it is
 * returned as {"key": "ARK1-…"}; otherwise {}. Nothing is stored about the install.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo '{}';
    exit;
}
$body = json_decode((string) file_get_contents('php://input', false, null, 0, 4096), true);
$customer = is_array($body) ? (string) ($body['customerId'] ?? '') : '';
$has = is_array($body) ? strtotime((string) ($body['validUntil'] ?? '')) : false;
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || $has === false) {
    http_response_code(400);
    echo '{}';
    exit;
}
$find = ark_db()->prepare("SELECT license_key, valid_until FROM licenses WHERE customer_id = ? AND status = 'active' AND license_key IS NOT NULL ORDER BY valid_until DESC LIMIT 1");
$find->execute([$customer]);
$row = $find->fetch();
if ($row && strtotime((string) $row['valid_until']) > $has) {
    echo json_encode(['key' => $row['license_key']], JSON_UNESCAPED_SLASHES);
    exit;
}
echo '{}';
