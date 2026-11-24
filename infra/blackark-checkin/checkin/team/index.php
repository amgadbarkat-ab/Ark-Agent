<?php
/**
 * https://blackark.uk/checkin/team/ — staff sub-profiles for the app (Amgad, 24 Nov 2026, #149).
 *
 * POST {customerId, installId, proof, quantity?, members?} with the install's own proof (as servers/).
 * EUR 15 a month per sub-profile, ON TOP of Ark Team's seats, and off by default: nothing exists in
 * Stripe until the administrator makes the first sub-profile.
 * - `quantity` (0 to 50): the number the administrator now wants. For a customer with an Ark Team
 *   subscription it is an item on that subscription, changed at once and prorated; charged now, and
 *   only applied if that charge succeeds (`pending_if_incomplete`), so a sub-profile is never active
 *   unpaid. A customer without one pays on a Stripe checkout first.
 * - Without `quantity`: only how many are paid now.
 * - `members`: the team as the app has it (name, email, role, status, created, number of employees),
 *   passed to the Control Board for BlackArk's team to see. Never kept here.
 * Answers {"paid": n, "status": "none"|"active"|"checkout"|"past_due"|…, "checkoutUrl": null|"https://…"}.
 * Each change of the paid number or status, and each changed team list, goes to the board (signed).
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function team_answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo $body ? json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    team_answer(405);
}
$raw = (string) file_get_contents('php://input', false, null, 0, 1048577);
$body = strlen($raw) > 1048576 ? null : json_decode($raw, true);
if (!is_array($body)) {
    team_answer(400);
}
$customer = (string) ($body['customerId'] ?? '');
$install = (string) ($body['installId'] ?? '');
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || $customer === 'unverified') {
    team_answer(400);
}
if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1) {
    team_answer(403);
}
$quantity = $body['quantity'] ?? null;
if ($quantity !== null && (!is_int($quantity) || $quantity < 0 || $quantity > ARK_SUBPROFILE_MAX)) {
    team_answer(400, ['error' => 'Not a number of sub-profiles.']);
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS team_requests (install_id TEXT NOT NULL, at INTEGER NOT NULL)');
$db->prepare('DELETE FROM team_requests WHERE at < ?')->execute([time() - 3600]);
$count = $db->prepare('SELECT COUNT(*) FROM team_requests WHERE install_id = ?');
$count->execute([$install]);
if ((int) $count->fetchColumn() >= (int) ark_config('servers_per_install_per_hour', 60)) {
    team_answer(429);
}
$db->prepare('INSERT INTO team_requests (install_id, at) VALUES (?, ?)')->execute([$install, time()]);

$ok = ark_install_proof_ok($body['proof'] ?? null, $customer);
if ($ok === null) {
    team_answer(503);
}
if ($ok !== true) {
    team_answer(403);
}
ark_board_flush($db, 5);
ark_subprofile_table($db);

$before = ark_subprofile_paid($db, $customer);
$checkoutUrl = null;
if ($quantity !== null && $quantity !== $before['paid']) {
    $price = ark_subprofile_price();
    if ($price === null) {
        team_answer(503, ['error' => 'Sub-profiles cannot be bought yet.']);
    }
    $read = $db->prepare('SELECT * FROM subprofile_plans WHERE customer_id = ?');
    $read->execute([$customer]);
    $plan = $read->fetch() ?: null;
    $change = ['quantity' => $quantity, 'proration_behavior' => 'always_invoice', 'payment_behavior' => 'pending_if_incomplete'];
    if ($plan && (string) $plan['item_id'] !== '') {
        ark_stripe_api('/v1/subscription_items/' . rawurlencode((string) $plan['item_id']), $change);
    } elseif ($quantity > 0) {
        $find = $db->prepare("SELECT subscription_id FROM licenses WHERE customer_id = ? AND status = 'active' AND subscription_id LIKE 'sub_%' ORDER BY updated_at DESC LIMIT 1");
        $find->execute([$customer]);
        $licence = (string) $find->fetchColumn();
        if ($licence !== '') {
            // On the customer's Ark Team subscription: one invoice, one renewal date.
            $item = ark_stripe_api('/v1/subscription_items', $change + [
                'subscription' => $licence,
                'price' => $price,
                'metadata' => ['kind' => 'subprofiles', 'customer_id' => $customer],
            ]);
            $db->prepare('INSERT INTO subprofile_plans (customer_id, subscription_id, item_id, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(customer_id) DO UPDATE SET subscription_id = excluded.subscription_id, item_id = excluded.item_id, updated_at = excluded.updated_at')
                ->execute([$customer, $licence, (string) ($item['id'] ?? ''), time()]);
        } else {
            // No Ark Team subscription (a trial): paid first, on a checkout of its own.
            $base = rtrim((string) ark_config('public_base_url', 'https://blackark.uk/checkin'), '/');
            $meta = ['kind' => 'subprofiles', 'customer_id' => $customer];
            $form = [
                'mode' => 'subscription',
                'client_reference_id' => $customer,
                'success_url' => $base . '/buy/?done=team',
                'cancel_url' => (string) ark_config('buy_cancel_url', 'https://blackark.uk/'),
                'locale' => 'el',
                'metadata' => $meta,
                'subscription_data' => ['metadata' => $meta],
                'line_items' => [['price' => $price, 'quantity' => $quantity]],
            ];
            if (ark_config('stripe_automatic_tax', false)) {
                $form['automatic_tax'] = ['enabled' => 'true'];
            }
            $session = ark_stripe_api('/v1/checkout/sessions', $form);
            $url = is_array($session) ? (string) ($session['url'] ?? '') : '';
            if (strpos($url, 'https://checkout.stripe.com/') !== 0) {
                error_log('ark-team: Stripe did not open a sub-profile checkout.');
                team_answer(502, ['error' => 'The payment page did not open. Try again shortly.']);
            }
            $checkoutUrl = $url;
            $db->prepare('INSERT INTO subprofile_plans (customer_id, session_id, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(customer_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at')
                ->execute([$customer, (string) ($session['id'] ?? ''), time()]);
        }
    }
}
$after = ark_subprofile_paid($db, $customer);

// The board learns each change of what is paid, once.
$read = $db->prepare('SELECT paid, status FROM subprofile_plans WHERE customer_id = ?');
$read->execute([$customer]);
$seen = $read->fetch() ?: null;
if ($seen && ((int) $seen['paid'] !== $after['paid'] || (string) $seen['status'] !== $after['status']) && $after['subscription'] !== null) {
    ark_board_send($db, '/intake/order', [
        'kind' => 'subprofiles',
        'event' => 'changed',
        'customerId' => $customer,
        'subscriptionId' => $after['subscription'],
        'quantity' => $after['paid'],
        'status' => $after['status'] === 'active' ? 'active' : ($after['paid'] === 0 && $after['status'] === 'canceled' ? 'cancelled' : 'past_due'),
        'startedAt' => gmdate('Y-m-d\TH:i:s\Z'),
    ]);
    $db->prepare('UPDATE subprofile_plans SET paid = ?, status = ?, updated_at = ? WHERE customer_id = ?')
        ->execute([$after['paid'], $after['status'], time(), $customer]);
}

// The team as the app has it, for the board: passed on when it changed, never kept here.
$members = $body['members'] ?? null;
if (is_array($members) && count($members) <= ARK_SUBPROFILE_MAX + 5) {
    $clean = [];
    $text = static fn ($v, int $max): string => is_string($v) ? (preg_match('/^.{0,' . $max . '}/su', $v, $m) === 1 ? $m[0] : '') : '';
    foreach ($members as $one) {
        if (!is_array($one)) {
            continue;
        }
        $clean[] = [
            'name' => $text($one['name'] ?? '', 120),
            'email' => filter_var($one['email'] ?? '', FILTER_VALIDATE_EMAIL) ? (string) $one['email'] : '',
            'role' => in_array($one['role'] ?? '', ['admin', 'subprofile'], true) ? $one['role'] : 'subprofile',
            'status' => in_array($one['status'] ?? '', ['pending_payment', 'active', 'suspended'], true) ? $one['status'] : 'active',
            'createdAt' => $text($one['createdAt'] ?? '', 40),
            'agents' => is_int($one['agents'] ?? null) ? max(0, $one['agents']) : 0,
        ];
    }
    $digest = hash('sha256', json_encode($clean));
    $db->exec('CREATE TABLE IF NOT EXISTS team_digests (customer_id TEXT PRIMARY KEY, digest TEXT NOT NULL, at INTEGER NOT NULL)');
    $old = $db->prepare('SELECT digest FROM team_digests WHERE customer_id = ?');
    $old->execute([$customer]);
    if ($old->fetchColumn() !== $digest) {
        ark_board_send($db, '/intake/team', ['customerId' => $customer, 'members' => $clean]);
        $db->prepare('INSERT INTO team_digests (customer_id, digest, at) VALUES (?, ?, ?)
            ON CONFLICT(customer_id) DO UPDATE SET digest = excluded.digest, at = excluded.at')
            ->execute([$customer, $digest, time()]);
    }
}

team_answer(200, ['paid' => $after['paid'], 'status' => $after['status'], 'checkoutUrl' => $checkoutUrl]);
