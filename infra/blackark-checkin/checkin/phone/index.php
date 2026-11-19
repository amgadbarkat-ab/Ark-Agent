<?php
/**
 * https://blackark.uk/checkin/phone/ — the phone relay's balance and charges (#109, v0.1.47).
 *
 * Only the relay calls this. Each request is JSON, signed with the shared secret in config.php
 * (`relay_secret`): X-Ark-Time is the Unix time, X-Ark-Signature the hex HMAC-SHA256 of
 * "<time>.<body>", accepted within 5 minutes.
 *
 *   {"action":"balance","customerId":"…"}
 *   {"action":"charge","customerId":"…","callId":"CA…","parts":[{"kind":"incoming","seconds":75}, …]}
 *
 * Both answer the balance (ark_phone_view), with the rates the relay sets each minute aside at. A
 * charge takes each part of a call once, by call id and kind, so a report the relay sends again
 * changes nothing, and never takes the balance below zero. No caller's number ever comes here.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function answer(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    answer(405, ['error' => 'POST only.']);
}
$secret = (string) ark_config('relay_secret', '');
if (strlen($secret) < 32) {
    answer(503, ['error' => 'Not configured.']);
}
$body = (string) file_get_contents('php://input', false, null, 0, 8193);
if (strlen($body) > 8192) {
    answer(413, ['error' => 'Too large.']);
}
$time = (int) ($_SERVER['HTTP_X_ARK_TIME'] ?? 0);
$signature = (string) ($_SERVER['HTTP_X_ARK_SIGNATURE'] ?? '');
if (abs(time() - $time) > 300 || !hash_equals(hash_hmac('sha256', $time . '.' . $body, $secret), $signature)) {
    answer(403, ['error' => 'Bad signature.']);
}
$request = json_decode($body, true);
$customer = is_array($request) ? (string) ($request['customerId'] ?? '') : '';
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1) {
    answer(400, ['error' => 'No customer.']);
}
$db = ark_db();

if (($request['action'] ?? '') === 'balance') {
    answer(200, ark_phone_view($db, $customer));
}
if (($request['action'] ?? '') !== 'charge') {
    answer(400, ['error' => 'Unknown action.']);
}
$callId = (string) ($request['callId'] ?? '');
$parts = $request['parts'] ?? null;
if (preg_match('/^CA[0-9a-f]{32}$/', $callId) !== 1 || !is_array($parts) || count($parts) < 1 || count($parts) > 3) {
    answer(400, ['error' => 'Not a charge.']);
}
foreach ($parts as $part) {
    $kind = is_array($part) ? ($part['kind'] ?? null) : null;
    $seconds = is_array($part) ? ($part['seconds'] ?? null) : null;
    if (!in_array($kind, ARK_PHONE_KINDS, true) || !is_int($seconds) || $seconds < 0 || $seconds > 86400) {
        answer(400, ['error' => 'Not a charge.']);
    }
}
foreach ($parts as $part) {
    $cost = ark_phone_cost($part['kind'], $part['seconds']);
    if ($cost['mils'] > 0) {
        ark_phone_post($db, $customer, 'call:' . $callId . ':' . $part['kind'], $part['kind'], $cost['minutes'], -$cost['mils']);
        // For the customer's usage in Stripe only (v0.1.49); once per call and part, never fatal.
        try {
            ark_meter_queue($db, $customer, $callId, $part['kind'], $cost['minutes']);
        } catch (Throwable $error) {
            error_log('ark-meter: not queued: ' . $error->getMessage());
        }
    }
}
ark_meter_flush($db, 50);
$view = ark_phone_view($db, $customer);
if ($view['state'] !== 'ok') {
    ark_phone_low_email($db, $customer, $view);
    ark_phone_auto_topup($db, $customer);
}
answer(200, $view);
