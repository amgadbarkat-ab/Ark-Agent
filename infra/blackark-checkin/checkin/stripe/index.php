<?php
/**
 * https://blackark.uk/checkin/stripe/ — Stripe's webhook for paid licence keys (#109, v0.1.44;
 * Amgad 16 Nov: "ok, go").
 *
 * Events, each checked with the Stripe-Signature header (HMAC-SHA256 with the webhook secret in
 * config.php, timestamp within 5 minutes) and taken once:
 * - checkout.session.completed: which subscription belongs to which customer id (the Payment Link's
 *   client_reference_id) and which checkout session, so the key page can find it.
 * - invoice.paid: the plan, seats and add-ons (from config's price table) and the paid period's end;
 *   a new key is signed, valid to that end plus the grace days.
 * - customer.subscription.updated (v0.1.49): a tier switch or a seat change in the billing portal
 *   updates the plan, seats and tier (`max_agents`) and signs a new key at once, for the same period.
 * - invoice.payment_failed (v0.1.49): no new key until the next paid invoice.
 * - customer.subscription.deleted: no more keys; the last one runs out on its own.
 * - Prepaid phone balance (v0.1.47): a checkout the buy page opened with the phone add-on, or a
 *   top-up, credits a 5-hour block once Stripe says it is paid (checkout.session.completed with
 *   payment_status "paid", or checkout.session.async_payment_succeeded). The checkout session id is
 *   the reference, so a repeated event credits nothing. An automatic top-up is a Stripe invoice
 *   (metadata kind "phone_topup"), credited on invoice.paid under the invoice id. A checkout where
 *   the customer chose "automatic top-up: yes" remembers that choice and the Stripe customer.
 *
 * Kept: the customer id, the Stripe subscription and session ids, the plan, seats, add-ons, the
 * period end and the latest key. No card data, no name, no email, no address.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(int $status, string $message = 'ok'): void
{
    http_response_code($status);
    echo json_encode(['result' => $message]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    reply(405, 'POST only.');
}
$secret = (string) ark_config('stripe_webhook_secret', '');
if ($secret === '') {
    reply(503, 'Not configured.');
}
$body = (string) file_get_contents('php://input', false, null, 0, 1048577);
if (strlen($body) > 1048576) {
    reply(413, 'Too large.');
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]
$header = (string) ($_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '');
$time = 0;
$signatures = [];
foreach (explode(',', $header) as $part) {
    [$name, $value] = array_pad(explode('=', trim($part), 2), 2, '');
    if ($name === 't') {
        $time = (int) $value;
    } elseif ($name === 'v1') {
        $signatures[] = $value;
    }
}
$expected = hash_hmac('sha256', $time . '.' . $body, $secret);
$valid = false;
foreach ($signatures as $signature) {
    if (hash_equals($expected, $signature)) {
        $valid = true;
    }
}
$now = time();
if (!$valid || abs($now - $time) > 300) {
    reply(400, 'Bad signature.');
}

$event = json_decode($body, true);
if (!is_array($event) || !is_string($event['id'] ?? null) || !is_string($event['type'] ?? null)) {
    reply(400, 'Not an event.');
}
$db = ark_db();
$seen = $db->prepare('INSERT OR IGNORE INTO stripe_events (event_id, received_at) VALUES (?, ?)');
$seen->execute([$event['id'], ark_now()]);
if ($seen->rowCount() === 0) {
    reply(200, 'Already taken.');
}
$object = is_array($event['data']['object'] ?? null) ? $event['data']['object'] : [];

function customer_id_from($reference, $customer): string
{
    $reference = is_string($reference) ? strtolower(trim($reference)) : '';
    if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $reference) === 1) {
        return $reference;
    }
    return 'stripe-' . strtolower(preg_replace('/[^A-Za-z0-9]/', '', (string) $customer));
}

function upsert(PDO $db, string $subscription, array $fields): void
{
    $db->prepare('INSERT OR IGNORE INTO licenses (subscription_id, updated_at) VALUES (?, ?)')
        ->execute([$subscription, ark_now()]);
    foreach ($fields as $column => $value) {
        $db->prepare("UPDATE licenses SET $column = ?, updated_at = ? WHERE subscription_id = ?")
            ->execute([$value, ark_now(), $subscription]);
    }
}

/** Signs a key once the row has both its customer (from checkout) and its plan (from the invoice). */
function issue(PDO $db, string $subscription): void
{
    $read = $db->prepare('SELECT * FROM licenses WHERE subscription_id = ?');
    $read->execute([$subscription]);
    $row = $read->fetch();
    if (!$row || $row['status'] !== 'active' || !$row['customer_id'] || !$row['plan'] || !$row['period_end']) {
        return;
    }
    $addons = $row['addons'] ? explode(',', (string) $row['addons']) : [];
    $maxAgents = $row['max_agents'] === null ? null : (int) $row['max_agents'];
    $signed = ark_sign_license((string) $row['customer_id'], (string) $row['plan'], (int) $row['seats'], $addons, (int) $row['period_end'], $maxAgents);
    if ($signed) {
        upsert($db, $subscription, ['license_key' => $signed['key'], 'valid_until' => $signed['valid_until']]);
    }
}

/**
 * The plan, seats, tier and add-ons that invoice lines or subscription items stand for, from the
 * price table in config.php; null when no line is a plan in it. Each line's quantity is its seats.
 * A plan price may carry `max_agents` (Ark Team's tier, v0.1.49); one without it is signed without a
 * tier, which the app counts as 5.
 */
function licence_from(array $lines, callable $periodEndOf): ?array
{
    $prices = (array) ark_config('stripe_prices', []);
    $plan = null;
    $seats = 1;
    $maxAgents = null;
    $addons = [];
    $periodEnd = 0;
    foreach ($lines as $line) {
        if (!is_array($line)) {
            continue;
        }
        $price = (string) ($line['price']['id'] ?? ($line['pricing']['price_details']['price'] ?? ''));
        $map = $prices[$price] ?? null;
        if (is_array($map) && isset($map['plan'])) {
            $plan = (string) $map['plan'];
            $seats = max(1, (int) ($map['seats'] ?? 1) * max(1, (int) ($line['quantity'] ?? 1)));
            $maxAgents = in_array($map['max_agents'] ?? null, ARK_AGENT_TIERS, true) ? (int) $map['max_agents'] : null;
            foreach ((array) ($map['addons'] ?? []) as $addon) {
                $addons[] = (string) $addon;
            }
        } elseif (is_array($map) && isset($map['addon'])) {
            $addons[] = (string) $map['addon'];
        }
        $periodEnd = max($periodEnd, $periodEndOf($line));
    }
    if ($plan === null) {
        return null;
    }
    return [
        'plan' => $plan,
        'seats' => $seats,
        'max_agents' => $maxAgents,
        'addons' => implode(',', array_unique($addons)),
        'period_end' => $periodEnd,
    ];
}

$subscription = (string) ($object['subscription'] ?? ($event['type'] === 'customer.subscription.deleted' ? ($object['id'] ?? '') : ''));
if (is_array($object['subscription'] ?? null)) {
    $subscription = (string) ($object['subscription']['id'] ?? '');
}
if ($subscription === '' && is_array($object['parent']['subscription_details'] ?? null)) {
    $subscription = (string) ($object['parent']['subscription_details']['subscription'] ?? '');
}

/** Credits the prepaid phone block a paid checkout from the buy page carries. */
function credit_phone(PDO $db, array $session): void
{
    $blocks = (int) ($session['metadata']['phone_blocks'] ?? 0);
    $customer = strtolower(trim((string) ($session['client_reference_id'] ?? '')));
    if ($blocks < 1 || ($session['payment_status'] ?? '') !== 'paid' || !is_string($session['id'] ?? null)
        || preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1) {
        return;
    }
    ark_phone_credit_blocks($db, $customer, $session['id'], $blocks);
    foreach ((array) ($session['custom_fields'] ?? []) as $field) {
        if (($field['key'] ?? '') === 'autotopup' && ($field['dropdown']['value'] ?? '') === 'yes'
            && is_string($session['customer'] ?? null) && preg_match('/^cus_[A-Za-z0-9]+$/', $session['customer']) === 1) {
            $db->prepare('UPDATE phone_accounts SET auto_topup = 1, stripe_customer = ? WHERE customer_id = ?')
                ->execute([$session['customer'], $customer]);
        }
    }
    $country = strtoupper((string) ($session['customer_details']['address']['country'] ?? ''));
    if (preg_match('/^[A-Z]{2}$/', $country) === 1) {
        // Only to choose the low-balance email's language (phone-emails.php).
        $db->prepare('UPDATE phone_accounts SET country = ? WHERE customer_id = ?')->execute([$country, $customer]);
    }
    $email = (string) ($session['customer_details']['email'] ?? '');
    if (ark_config('phone_low_email', false) && filter_var($email, FILTER_VALIDATE_EMAIL)) {
        // Kept only while the low-balance email is on, and only to send that notice.
        $db->prepare('UPDATE phone_accounts SET email = ? WHERE customer_id = ?')->execute([$email, $customer]);
    }
}

/*
 * 24/7 Priority Support (Amgad, 24 Nov 2026): a subscription the buy page opened with metadata kind
 * "support_247". Kept in support_plans, never in licenses. Each change goes to the Control Board as an
 * order (`/intake/order`, signed): the paid checkout opens the board's case with the name, company and
 * email Stripe collected (passed through, never kept here); each paid invoice, failed renewal and the
 * end update the same case. Handled here, before everything else, and answered.
 */
ark_support_plans_table($db);
$supportRow = null;
if ($subscription !== '') {
    $read = $db->prepare('SELECT * FROM support_plans WHERE subscription_id = ?');
    $read->execute([$subscription]);
    $supportRow = $read->fetch() ?: null;
}
$supportMeta = (array) ($object['metadata'] ?? []);
if (($supportMeta['kind'] ?? '') !== 'support_247') {
    $supportMeta = (array) ($object['subscription_details']['metadata'] ?? ($object['parent']['subscription_details']['metadata'] ?? []));
}
if ($supportRow !== null || ($supportMeta['kind'] ?? '') === 'support_247') {
    $licence = function (string $customer) use ($db): string {
        $find = $db->prepare("SELECT plan, status FROM licenses WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1");
        $find->execute([$customer]);
        $row = $find->fetch();
        return $row ? ((string) $row['plan'] . ' (' . (string) $row['status'] . ')') : 'no paid licence on file (trial or not activated)';
    };
    $order = function (string $event, array $row, array $who = []) use ($db, $licence): void {
        ark_board_send($db, '/intake/order', [
            'kind' => 'support_247',
            'event' => $event,
            'customerId' => (string) $row['customer_id'],
            'subscriptionId' => (string) $row['subscription_id'],
            'status' => (string) $row['status'],
            'startedAt' => gmdate('Y-m-d\TH:i:s\Z', (int) $row['started_at']),
            'paidUntil' => !empty($row['paid_until']) ? gmdate('Y-m-d\TH:i:s\Z', (int) $row['paid_until']) : null,
            'licence' => $licence((string) $row['customer_id']),
        ] + $who);
    };
    switch ($event['type']) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
            $customer = strtolower(trim((string) ($object['client_reference_id'] ?? '')));
            $paid = in_array($object['payment_status'] ?? '', ['paid', 'no_payment_required'], true);
            if (!$paid || preg_match('/^sub_[A-Za-z0-9_]+$/', $subscription) !== 1
                || preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1) {
                reply(200, 'Support order not paid yet, or not complete.');
            }
            $db->prepare('INSERT OR IGNORE INTO support_plans (subscription_id, customer_id, status, session_id, started_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)')
                ->execute([$subscription, $customer, 'active', (string) ($object['id'] ?? ''), $now, $now]);
            $read = $db->prepare('SELECT * FROM support_plans WHERE subscription_id = ?');
            $read->execute([$subscription]);
            $company = '';
            foreach ((array) ($object['custom_fields'] ?? []) as $field) {
                if (($field['key'] ?? '') === 'company') {
                    $company = (string) ($field['text']['value'] ?? '');
                }
            }
            $details = (array) ($object['customer_details'] ?? []);
            // The first 200 characters of UTF-8 text (no mbstring needed on the host).
            $cut = static fn (string $text): string => preg_match('/^.{0,200}/su', trim($text), $m) === 1 ? $m[0] : '';
            $order('started', $read->fetch(), [
                'name' => $cut((string) ($details['name'] ?? '')),
                'company' => $cut($company),
                'email' => filter_var((string) ($details['email'] ?? ''), FILTER_VALIDATE_EMAIL) ? (string) $details['email'] : '',
            ]);
            reply(200, 'Support ordered.');
        case 'invoice.paid':
            if ($supportRow !== null) {
                $periodEnd = 0;
                foreach ((array) ($object['lines']['data'] ?? []) as $line) {
                    $periodEnd = max($periodEnd, (int) ($line['period']['end'] ?? 0));
                }
                $db->prepare("UPDATE support_plans SET paid_until = MAX(COALESCE(paid_until, 0), ?), status = CASE status WHEN 'cancelled' THEN status ELSE 'active' END, updated_at = ? WHERE subscription_id = ?")
                    ->execute([$periodEnd, $now, $subscription]);
                $read = $db->prepare('SELECT * FROM support_plans WHERE subscription_id = ?');
                $read->execute([$subscription]);
                $order('renewed', $read->fetch());
            }
            reply(200, 'Support paid.');
        case 'invoice.payment_failed':
            if ($supportRow !== null) {
                $db->prepare("UPDATE support_plans SET status = 'past_due', updated_at = ? WHERE subscription_id = ? AND status <> 'cancelled'")
                    ->execute([$now, $subscription]);
                $read = $db->prepare('SELECT * FROM support_plans WHERE subscription_id = ?');
                $read->execute([$subscription]);
                $order('payment_failed', $read->fetch());
            }
            reply(200, 'Support renewal failed.');
        case 'customer.subscription.deleted':
            if ($supportRow !== null) {
                $db->prepare("UPDATE support_plans SET status = 'cancelled', updated_at = ? WHERE subscription_id = ?")
                    ->execute([$now, $subscription]);
                $read = $db->prepare('SELECT * FROM support_plans WHERE subscription_id = ?');
                $read->execute([$subscription]);
                $order('cancelled', $read->fetch());
            }
            reply(200, 'Support cancelled.');
        default:
            reply(200, 'Support event ignored.');
    }
}

/*
 * Ark Private Server (#149, 19 Nov): a subscription the buy page opened with metadata kind
 * "private_server". Kept in private_servers, never in licenses, so it signs no licence key and a
 * licence's end never touches it. A paid checkout records the order as "setting_up" (BlackArk orders
 * the server and sets it up by hand); each paid invoice moves "paid until"; the subscription's end
 * marks it cancelled. Handled here, before the licence events, and answered.
 */
ark_private_servers_table($db);
$serverRow = null;
if ($subscription !== '') {
    $read = $db->prepare('SELECT * FROM private_servers WHERE subscription_id = ?');
    $read->execute([$subscription]);
    $serverRow = $read->fetch() ?: null;
}
$serverMeta = (array) ($object['metadata'] ?? []);
if (($serverMeta['kind'] ?? '') !== 'private_server') {
    $serverMeta = (array) ($object['subscription_details']['metadata'] ?? ($object['parent']['subscription_details']['metadata'] ?? []));
}
$isServer = $serverRow !== null || ($serverMeta['kind'] ?? '') === 'private_server';
if ($isServer) {
    switch ($event['type']) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
            $customer = strtolower(trim((string) ($object['client_reference_id'] ?? '')));
            $tier = (string) ($serverMeta['server_tier'] ?? '');
            $paid = in_array($object['payment_status'] ?? '', ['paid', 'no_payment_required'], true);
            if (!$paid || preg_match('/^sub_[A-Za-z0-9_]+$/', $subscription) !== 1
                || preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1 || !isset(ark_server_catalogue()[$tier])) {
                reply(200, 'Server order not paid yet, or not complete.');
            }
            $db->prepare('INSERT OR IGNORE INTO private_servers (subscription_id, customer_id, tier, status, session_id, ordered_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$subscription, $customer, $tier, 'setting_up', (string) ($object['id'] ?? ''), $now, $now]);
            error_log('ark-server: new order ' . $tier . ' for ' . $customer . ': set it up, then attach it in checkin/admin/.');
            reply(200, 'Server ordered.');
        case 'invoice.paid':
            if ($serverRow !== null) {
                $periodEnd = 0;
                foreach ((array) ($object['lines']['data'] ?? []) as $line) {
                    $periodEnd = max($periodEnd, (int) ($line['period']['end'] ?? 0));
                }
                if ($periodEnd > (int) $serverRow['paid_until']) {
                    $db->prepare('UPDATE private_servers SET paid_until = ?, updated_at = ? WHERE subscription_id = ?')
                        ->execute([$periodEnd, $now, $subscription]);
                }
            }
            reply(200, 'Server paid.');
        case 'customer.subscription.deleted':
            if ($serverRow !== null) {
                $db->prepare("UPDATE private_servers SET status = 'cancelled', updated_at = ? WHERE subscription_id = ?")
                    ->execute([$now, $subscription]);
            }
            reply(200, 'Server cancelled.');
        default:
            reply(200, 'Server event ignored.');
    }
}

switch ($event['type']) {
    case 'checkout.session.async_payment_succeeded':
        credit_phone($db, $object);
        reply(200);
    case 'checkout.session.completed':
        credit_phone($db, $object);
        if ($subscription === '') {
            reply(200, 'Not a subscription.');
        }
        upsert($db, $subscription, [
            'customer_id' => customer_id_from($object['client_reference_id'] ?? null, $object['customer'] ?? ''),
            'session_id' => (string) ($object['id'] ?? ''),
            // The buyer's Stripe customer, for every buyer (v0.1.49): the phone usage meters need it.
            'stripe_customer' => preg_match('/^cus_[A-Za-z0-9]+$/', (string) ($object['customer'] ?? '')) === 1 ? (string) $object['customer'] : null,
        ]);
        issue($db, $subscription);
        reply(200);
    case 'invoice.paid':
        if (($object['metadata']['kind'] ?? '') === 'phone_topup') {
            // An automatic top-up this server asked Stripe for: one block, credited once.
            $customer = strtolower((string) ($object['metadata']['customer_id'] ?? ''));
            if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) === 1 && is_string($object['id'] ?? null)) {
                ark_phone_credit_blocks($db, $customer, $object['id'], (int) ($object['metadata']['phone_blocks'] ?? 1));
            }
            reply(200);
        }
        if ($subscription === '') {
            reply(200, 'Not a subscription.');
        }
        $licence = licence_from((array) ($object['lines']['data'] ?? []), fn ($line) => (int) ($line['period']['end'] ?? 0));
        if ($licence === null) {
            reply(200, 'No price in this invoice is in the price table.');
        }
        upsert($db, $subscription, [
            'plan' => $licence['plan'],
            'seats' => $licence['seats'],
            'max_agents' => $licence['max_agents'],
            'addons' => $licence['addons'],
            'period_end' => $licence['period_end'] ?: (int) ($object['period_end'] ?? 0),
            'status' => 'active',
        ]);
        issue($db, $subscription);
        reply(200);
    case 'customer.subscription.updated':
        // A tier switch or a seat change in the billing portal (v0.1.49): a new key at once, for the
        // same paid period. The app's daily renewal check picks it up.
        $subscription = (string) ($object['id'] ?? '');
        if (preg_match('/^sub_[A-Za-z0-9_]+$/', $subscription) !== 1) {
            reply(200, 'Not a subscription.');
        }
        $licence = licence_from((array) ($object['items']['data'] ?? []), fn ($item) => (int) ($item['current_period_end'] ?? 0));
        if ($licence === null) {
            reply(200, 'No price in this subscription is in the price table.');
        }
        $status = (string) ($object['status'] ?? '');
        $fields = [
            'plan' => $licence['plan'],
            'seats' => $licence['seats'],
            'max_agents' => $licence['max_agents'],
            'addons' => $licence['addons'],
        ];
        $periodEnd = $licence['period_end'] ?: (int) ($object['current_period_end'] ?? 0);
        $read = $db->prepare('SELECT period_end FROM licenses WHERE subscription_id = ?');
        $read->execute([$subscription]);
        $paidTo = (int) $read->fetchColumn();
        if ($periodEnd > 0 && $paidTo > 0 && $periodEnd < $paidTo) {
            // Never later than what was paid: a new period's end arrives with its invoice.paid, so a
            // renewal whose payment then fails never gets a longer key from this event.
            $fields['period_end'] = $periodEnd;
        }
        if (in_array($status, ['canceled', 'unpaid', 'incomplete_expired'], true)) {
            $fields['status'] = 'canceled';
        } elseif ($status === 'past_due') {
            $fields['status'] = 'past_due';
        }
        upsert($db, $subscription, $fields);
        issue($db, $subscription);
        reply(200);
    case 'invoice.payment_failed':
        // No new key until the next paid invoice; the last one runs out on its own (its period end
        // plus the grace days), as before. Stripe retries the card.
        if ($subscription !== '') {
            upsert($db, $subscription, ['status' => 'past_due']);
        }
        reply(200);
    case 'customer.subscription.deleted':
        if ($subscription !== '') {
            upsert($db, $subscription, ['status' => 'canceled']);
        }
        reply(200);
    default:
        reply(200, 'Ignored.');
}
