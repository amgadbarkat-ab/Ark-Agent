<?php
/**
 * BlackArk trial check-in receiver (#109): shared code for the receiver and the status page.
 *
 * Runs on plain PHP + Apache shared hosting (one.com). PHP 7.4 or newer, with PDO SQLite. The
 * sodium extension, when present, checks that a check-in carries a BlackArk-signed trial profile.
 *
 * Nothing here stores anything a customer wrote: a check-in is the customer id, a random install
 * id, the app version, the trial status, the days left, the end date and the number of trial
 * employees. No IP address is stored.
 */

declare(strict_types=1);

if (!defined('ARK_CHECKIN')) {
    http_response_code(404);
    exit;
}

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not configured: copy config.sample.php to config.php.\n";
    exit;
}
$CONFIG = require $configFile;

/** Ark Team's tiers (v0.1.49): digital employees per seat, as shared/plans.ts has them. */
const ARK_AGENT_TIERS = [5, 10, 20];

function ark_config(string $key, $default = null)
{
    global $CONFIG;
    return array_key_exists($key, $CONFIG) ? $CONFIG[$key] : $default;
}

function ark_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $dir = rtrim((string) ark_config('data_dir', __DIR__ . '/data'), '/');
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('The data folder cannot be created.');
    }
    $pdo = new PDO('sqlite:' . $dir . '/checkins.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS installs (
        install_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        days_left INTEGER NOT NULL,
        ends_at TEXT,
        employees INTEGER,
        verified INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        checkins INTEGER NOT NULL DEFAULT 1
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS installs_customer ON installs (customer_id)');
    // Counts from v0.1.49 (#149): added to an existing file once, empty for older installs.
    $columns = array_column($pdo->query('PRAGMA table_info(installs)')->fetchAll(), 'name');
    foreach (['people' => 'INTEGER', 'active_people_7d' => 'INTEGER', 'conversations_7d' => 'INTEGER', 'phone_line' => 'INTEGER', 'os' => 'TEXT'] as $column => $type) {
        if (!in_array($column, $columns, true)) {
            $pdo->exec("ALTER TABLE installs ADD COLUMN $column $type");
        }
    }
    $pdo->exec('CREATE TABLE IF NOT EXISTS login_failures (at INTEGER NOT NULL)');
    // Paid licence keys from Stripe (v0.1.44): one row per subscription, its latest signed key.
    $pdo->exec('CREATE TABLE IF NOT EXISTS licenses (
        subscription_id TEXT PRIMARY KEY,
        customer_id TEXT,
        session_id TEXT,
        plan TEXT,
        seats INTEGER,
        addons TEXT,
        period_end INTEGER,
        status TEXT NOT NULL DEFAULT \'active\',
        license_key TEXT,
        valid_until TEXT,
        updated_at TEXT NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS licenses_session ON licenses (session_id)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS licenses_customer ON licenses (customer_id)');
    // Ark Team's tier (v0.1.49), and the buyer's Stripe customer (cus_…) for the usage meters:
    // added to an existing file once, empty for older rows.
    $licenceColumns = array_column($pdo->query('PRAGMA table_info(licenses)')->fetchAll(), 'name');
    foreach (['max_agents' => 'INTEGER', 'stripe_customer' => 'TEXT'] as $column => $type) {
        if (!in_array($column, $licenceColumns, true)) {
            $pdo->exec("ALTER TABLE licenses ADD COLUMN $column $type");
        }
    }
    $pdo->exec('CREATE TABLE IF NOT EXISTS stripe_events (event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL)');
    // Prepaid phone balance (v0.1.47): one account per customer, in mils (1/1000 euro, excl. VAT),
    // and every credit and charge, each under a reference that can be taken only once.
    $pdo->exec('CREATE TABLE IF NOT EXISTS phone_accounts (
        customer_id TEXT PRIMARY KEY,
        balance_mils INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        country TEXT,
        low_notified_at TEXT,
        auto_topup INTEGER NOT NULL DEFAULT 0,
        stripe_customer TEXT,
        auto_topup_at TEXT,
        updated_at TEXT NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS phone_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL,
        ref TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        minutes INTEGER NOT NULL DEFAULT 0,
        mils INTEGER NOT NULL,
        written_off_mils INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS phone_ledger_customer ON phone_ledger (customer_id, id)');
    // Phone usage for Stripe's meters (v0.1.49): one row per part of a call, sent once, kept to retry.
    $pdo->exec('CREATE TABLE IF NOT EXISTS meter_events (
        identifier TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TEXT
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS meter_events_waiting ON meter_events (sent_at, at)');
    return $pdo;
}

function ark_now(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

function ark_base64url_decode(string $text)
{
    if ($text === '' || preg_match('/^[A-Za-z0-9_-]+$/', $text) !== 1) {
        return false;
    }
    $padded = strtr($text, '-_', '+/');
    $padded .= str_repeat('=', (4 - strlen($padded) % 4) % 4);
    return base64_decode($padded, true);
}

/**
 * Whether `proof` is a trial profile signed with a BlackArk key and made for this customer.
 * True: signed and for this customer. False: present but wrong. Null: cannot be checked here.
 */
function ark_proof_ok($proof, string $customerId): ?bool
{
    if (!is_array($proof) || !is_string($proof['profile'] ?? null) || !is_string($proof['signature'] ?? null)) {
        return false;
    }
    if (!function_exists('sodium_crypto_sign_verify_detached')) {
        return null;
    }
    $signature = ark_base64url_decode($proof['signature']);
    if ($signature === false || strlen($signature) !== 64) {
        return false;
    }
    $signedBy = false;
    foreach ((array) ark_config('trial_public_keys', []) as $encoded) {
        $key = base64_decode((string) $encoded, true);
        if ($key === false || strlen($key) !== 32) {
            continue;
        }
        if (sodium_crypto_sign_verify_detached($signature, $proof['profile'], $key)) {
            $signedBy = true;
            break;
        }
    }
    if (!$signedBy) {
        return false;
    }
    $json = ark_base64url_decode($proof['profile']);
    $profile = $json === false ? null : json_decode($json, true);
    return is_array($profile) && (($profile['customer']['id'] ?? null) === $customerId);
}

function ark_send_security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
}

function ark_base64url(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

/**
 * A paid licence key (v0.1.44), the same `ARK1-` format the app reads (shared/activation.ts):
 * base64url JSON, a dot, and the Ed25519 signature over exactly that base64url text, made with the
 * licence secret key in config.php. Null when this server has no licence key or no sodium.
 */
function ark_sign_license(string $customerId, string $plan, int $seats, array $addons, int $periodEnd, ?int $maxAgents = null): ?array
{
    // Ark Team's tier (v0.1.49): 5, 10 or 20 digital employees per seat, signed with the rest. Any
    // other number is left out, and the app then counts the key as 5.
    $maxAgents = in_array($maxAgents, ARK_AGENT_TIERS, true) ? $maxAgents : null;
    $secret = base64_decode((string) ark_config('license_secret_key', ''), true);
    if ($secret === false || strlen($secret) !== 64 || !function_exists('sodium_crypto_sign_detached')) {
        return null;
    }
    $validUntil = gmdate('Y-m-d\TH:i:s\Z', $periodEnd + 86400 * (int) ark_config('license_grace_days', 7));
    $payload = [
        'v' => 1,
        'action' => 'license',
        'customer' => $customerId,
        'nonce' => ark_base64url(random_bytes(12)),
        'issuedAt' => ark_now(),
        'plan' => $plan,
        'seats' => $seats,
        'validUntil' => $validUntil,
    ];
    if ($maxAgents !== null) {
        $payload['maxAgents'] = $maxAgents;
    }
    if ($addons) {
        $payload['addons'] = array_values($addons);
    }
    $renew = (string) ark_config('license_renew_url', '');
    if ($renew !== '') {
        $payload['renewUrl'] = $renew;
    }
    $encoded = ark_base64url(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    $signature = ark_base64url(sodium_crypto_sign_detached($encoded, $secret));
    return ['key' => 'ARK1-' . $encoded . '.' . $signature, 'valid_until' => $validUntil];
}

// ---- Prepaid phone balance (v0.1.47; Amgad 17 Nov) ------------------------------------------------
//
// A money balance in mils (1/1000 euro, excl. VAT). A 5-hour block is priced at the incoming rate
// (EUR 23.40) and credited as money; each part of a call takes off its whole minutes at its own rate.
// Every credit and charge has a reference (a Stripe checkout session or invoice, a Twilio call id and
// part) taken only once, so a webhook or a relay report that arrives twice changes nothing.
//
// NEVER BELOW ZERO (Amgad, 17 Nov 12:29). The relay ends a call before a minute the balance cannot
// pay; if Twilio still reports a little more than was left, the balance stops at zero and the rest is
// written off at BlackArk's cost, recorded on the ledger row, never carried as debt.

const ARK_PHONE_KINDS = ['incoming', 'landline', 'mobile'];

function ark_phone_rates(): array
{
    $rates = (array) ark_config('phone_rates_mils', []);
    return [
        'incoming' => (int) ($rates['incoming'] ?? 78),
        'landline' => (int) ($rates['landline'] ?? 88),
        'mobile' => (int) ($rates['mobile'] ?? 139),
    ];
}

function ark_phone_block_mils(): int
{
    return (int) ark_config('phone_block_mils', 23400);
}

/** What a part of a call costs: its seconds rounded up to whole minutes, at its rate. */
function ark_phone_cost(string $kind, int $seconds): array
{
    $minutes = $seconds > 0 ? intdiv($seconds + 59, 60) : 0;
    return ['minutes' => $minutes, 'mils' => $minutes * (ark_phone_rates()[$kind] ?? 0)];
}

/** ok; low (the last hour); empty (cannot pay one more minute: calls are not answered). */
function ark_phone_state(int $balance): string
{
    if ($balance < ark_phone_rates()['incoming']) {
        return 'empty';
    }
    return $balance <= (int) ark_config('phone_low_mils', 8340) ? 'low' : 'ok';
}

function ark_phone_balance(PDO $db, string $customerId): int
{
    $find = $db->prepare('SELECT balance_mils FROM phone_accounts WHERE customer_id = ?');
    $find->execute([$customerId]);
    $balance = $find->fetchColumn();
    return $balance === false ? 0 : (int) $balance;
}

/**
 * Adds one ledger entry and moves the balance by it, once per reference. A charge never takes the
 * balance below zero: what it cannot cover is written off on the same row. Returns false when the
 * reference was already taken (nothing changes).
 */
function ark_phone_post(PDO $db, string $customerId, string $ref, string $kind, int $minutes, int $mils): bool
{
    $db->beginTransaction();
    try {
        $db->prepare('INSERT OR IGNORE INTO phone_accounts (customer_id, balance_mils, updated_at) VALUES (?, 0, ?)')
            ->execute([$customerId, ark_now()]);
        $writtenOff = 0;
        if ($mils < 0) {
            $balance = max(0, ark_phone_balance($db, $customerId));
            if (-$mils > $balance) {
                $writtenOff = -$mils - $balance;
                $mils = -$balance;
            }
        }
        $insert = $db->prepare('INSERT OR IGNORE INTO phone_ledger (customer_id, ref, kind, minutes, mils, written_off_mils, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        $insert->execute([$customerId, $ref, $kind, $minutes, $mils, $writtenOff, ark_now()]);
        if ($insert->rowCount() === 0) {
            $db->rollBack();
            return false;
        }
        if ($writtenOff > 0) {
            error_log("ark-phone: $ref charged past the balance; $writtenOff mils written off");
        }
        $db->prepare('UPDATE phone_accounts SET balance_mils = balance_mils + ?, updated_at = ? WHERE customer_id = ?')
            ->execute([$mils, ark_now(), $customerId]);
        if ($mils > 0 && ark_phone_balance($db, $customerId) > (int) ark_config('phone_low_mils', 8340)) {
            // Topped up past the last hour: the next time it runs low is worth a notice again.
            $db->prepare('UPDATE phone_accounts SET low_notified_at = NULL WHERE customer_id = ?')->execute([$customerId]);
        }
        $db->commit();
        return true;
    } catch (Throwable $error) {
        $db->rollBack();
        throw $error;
    }
}

/** Credits `blocks` 5-hour blocks for a paid Stripe checkout session or invoice (its id is `ref`). */
function ark_phone_credit_blocks(PDO $db, string $customerId, string $ref, int $blocks): bool
{
    $blocks = max(1, min(10, $blocks));
    $credited = ark_phone_post($db, $customerId, 'stripe:' . $ref, 'block', $blocks * 300, $blocks * ark_phone_block_mils());
    if ($credited) {
        // A paid block: the next automatic top-up may start when this one runs low.
        $db->prepare('UPDATE phone_accounts SET auto_topup_at = NULL WHERE customer_id = ?')->execute([$customerId]);
    }
    return $credited;
}

/** The top-up page for this customer, which opens a Stripe Checkout for one 5-hour block. */
function ark_phone_topup_url(string $customerId): string
{
    $base = rtrim((string) ark_config('buy_url', 'https://blackark.uk/checkin/buy/'), '/') . '/';
    return $base . '?topup=1&customer=' . rawurlencode($customerId);
}

/** The balance as the relay and the app read it. */
function ark_phone_view(PDO $db, string $customerId): array
{
    $balance = ark_phone_balance($db, $customerId);
    $rates = ark_phone_rates();
    return [
        'customerId' => $customerId,
        'balanceMils' => $balance,
        'state' => ark_phone_state($balance),
        // At the mobile rate, so it is never more than what is left.
        'minutesLeftAtLeast' => $balance > 0 ? intdiv($balance, max(1, $rates['mobile'])) : 0,
        'topUpUrl' => ark_phone_topup_url($customerId),
        // The relay sets aside each minute at these rates before it starts, so calls stop at zero.
        'rates' => $rates,
    ];
}

/**
 * Automatic top-up (optional, chosen at checkout): when the last hour starts, charge the card saved
 * with the subscription for one 5-hour block, through a Stripe invoice so VAT is added the same way.
 * The block is credited only when Stripe says the invoice is paid (invoice.paid). At most one attempt
 * per block: a declined card leaves the app's notice and the Add 5 hours button.
 */
function ark_phone_auto_topup(PDO $db, string $customerId): void
{
    $find = $db->prepare('SELECT auto_topup, stripe_customer, auto_topup_at FROM phone_accounts WHERE customer_id = ?');
    $find->execute([$customerId]);
    $row = $find->fetch();
    if (!$row || !(int) $row['auto_topup'] || !$row['stripe_customer'] || $row['auto_topup_at']) {
        return;
    }
    $block = (string) (((array) ark_config('stripe_buy', []))['block'] ?? '');
    $sub = $db->prepare("SELECT subscription_id FROM licenses WHERE customer_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1");
    $sub->execute([$customerId]);
    $subscription = (string) ($sub->fetchColumn() ?: '');
    if ($block === '' || $subscription === '') {
        return;
    }
    $mark = $db->prepare('UPDATE phone_accounts SET auto_topup_at = ? WHERE customer_id = ? AND auto_topup_at IS NULL');
    $mark->execute([ark_now(), $customerId]);
    if ($mark->rowCount() === 0) {
        return;
    }
    $customer = (string) $row['stripe_customer'];
    $item = ark_stripe_api('/v1/invoiceitems', ['customer' => $customer, 'subscription' => $subscription, 'price' => $block]);
    $invoice = is_array($item) && isset($item['id']) ? ark_stripe_api('/v1/invoices', array_merge([
        'customer' => $customer,
        'subscription' => $subscription,
        'pending_invoice_items_behavior' => 'include',
        'collection_method' => 'charge_automatically',
        'metadata' => ['kind' => 'phone_topup', 'customer_id' => $customerId, 'phone_blocks' => '1'],
    ], ark_config('stripe_automatic_tax', false) ? ['automatic_tax' => ['enabled' => 'true']] : [])) : null;
    $id = is_array($invoice) ? (string) ($invoice['id'] ?? '') : '';
    if (preg_match('/^in_[A-Za-z0-9_]+$/', $id) !== 1) {
        error_log('ark-phone: automatic top-up for ' . $customerId . ' was not created');
        return;
    }
    ark_stripe_api('/v1/invoices/' . $id . '/finalize', []);
    ark_stripe_api('/v1/invoices/' . $id . '/pay', []);
}

/**
 * Calls Stripe's API with the restricted key in config.php (form-encoded, as Stripe takes it).
 * Returns the decoded answer, or null when the key is missing or Stripe could not be reached.
 */
function ark_stripe_api(string $path, array $form): ?array
{
    $key = (string) ark_config('stripe_api_key', '');
    if ($key === '') {
        return null;
    }
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Authorization: Bearer $key\r\nContent-Type: application/x-www-form-urlencoded\r\n",
        'content' => http_build_query($form, '', '&'),
        'timeout' => 15,
        'ignore_errors' => true,
    ]]);
    $base = rtrim((string) ark_config('stripe_api_base', 'https://api.stripe.com'), '/');
    $raw = @file_get_contents($base . $path, false, $context);
    if ($raw === false) {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}


// ---- Phone usage to Stripe's meters (v0.1.49; COO's setup of 19 Nov) -------------------------------
//
// ONLY SO CUSTOMERS SEE THEIR USAGE. Billing stays the prepaid 5-hour blocks above; the per-minute
// prices on the phone add-on are not charged. Each part of a call booked by ark_phone_post is queued
// here with its whole minutes, then sent as one meter event, with an identifier made of the call id
// and the part so Stripe counts a retry once. Never fatal: without the key (`stripe_meter_key`, a
// restricted key with "Billing meter events: write" only), without the buyer's Stripe customer, or
// with Stripe down, the event waits and is tried again with the next call; the call and the balance
// are not affected. The board shows how many wait.

const ARK_METER_EVENTS = [
    'incoming' => 'arkagent_phone_minutes_incoming',
    'landline' => 'arkagent_phone_minutes_landline',
    'mobile' => 'arkagent_phone_minutes_mobile',
];

/** Queues one part of a call for its meter, once per call and part. */
function ark_meter_queue(PDO $db, string $customerId, string $callId, string $kind, int $minutes): void
{
    if ($minutes < 1 || !isset(ARK_METER_EVENTS[$kind])) {
        return;
    }
    $db->prepare('INSERT OR IGNORE INTO meter_events (identifier, customer_id, kind, minutes, at) VALUES (?, ?, ?, ?, ?)')
        ->execute(['call_' . $callId . '_' . $kind, $customerId, $kind, $minutes, time()]);
}

/** The buyer's Stripe customer (cus_…), from the paid checkout, or the automatic top-up's. */
function ark_meter_customer(PDO $db, string $customerId): ?string
{
    $find = $db->prepare("SELECT stripe_customer FROM licenses WHERE customer_id = ? AND stripe_customer IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
    $find->execute([$customerId]);
    $found = (string) ($find->fetchColumn() ?: '');
    if ($found === '') {
        $find = $db->prepare('SELECT stripe_customer FROM phone_accounts WHERE customer_id = ? AND stripe_customer IS NOT NULL');
        $find->execute([$customerId]);
        $found = (string) ($find->fetchColumn() ?: '');
    }
    return preg_match('/^cus_[A-Za-z0-9]+$/', $found) === 1 ? $found : null;
}

/** Sends what waits, oldest first, at most `$limit`. Returns how many went. Never throws. */
function ark_meter_flush(PDO $db, int $limit = 20): int
{
    $key = (string) ark_config('stripe_meter_key', '');
    if ($key === '') {
        return 0;
    }
    $sent = 0;
    try {
        $waiting = $db->query('SELECT identifier, customer_id, kind, minutes, at FROM meter_events WHERE sent_at IS NULL ORDER BY at, identifier LIMIT ' . max(1, $limit))->fetchAll();
        $base = rtrim((string) ark_config('stripe_api_base', 'https://api.stripe.com'), '/');
        foreach ($waiting as $row) {
            $customer = ark_meter_customer($db, (string) $row['customer_id']);
            if ($customer === null) {
                $db->prepare("UPDATE meter_events SET last_error = 'no Stripe customer yet' WHERE identifier = ?")->execute([$row['identifier']]);
                continue;
            }
            $form = [
                'event_name' => ARK_METER_EVENTS[$row['kind']] ?? '',
                'payload' => ['stripe_customer_id' => $customer, 'value' => (string) $row['minutes']],
                'identifier' => (string) $row['identifier'],
                'timestamp' => (string) $row['at'],
            ];
            $context = stream_context_create(['http' => [
                'method' => 'POST',
                'header' => "Authorization: Bearer $key\r\nContent-Type: application/x-www-form-urlencoded\r\n",
                'content' => http_build_query($form, '', '&'),
                'timeout' => 5,
                'ignore_errors' => true,
            ]]);
            $raw = @file_get_contents($base . '/v1/billing/meter_events', false, $context);
            $status = 0;
            foreach ((array) ($http_response_header ?? []) as $line) {
                if (preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $line, $match) === 1) {
                    $status = (int) $match[1];
                }
            }
            $answer = is_string($raw) ? json_decode($raw, true) : null;
            $duplicate = $status === 400 && stripos((string) ($answer['error']['message'] ?? ''), 'identifier') !== false;
            if (($status >= 200 && $status < 300) || $duplicate) {
                // A duplicate identifier means Stripe already counted it: done, not again.
                $db->prepare('UPDATE meter_events SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE identifier = ?')
                    ->execute([ark_now(), $row['identifier']]);
                $sent += 1;
                continue;
            }
            $db->prepare('UPDATE meter_events SET attempts = attempts + 1, last_error = ? WHERE identifier = ?')
                ->execute([$status === 0 ? 'Stripe not reached' : "Stripe answered $status", $row['identifier']]);
            if ($status === 0 || $status >= 500) {
                break; // Stripe is down: the rest wait for the next call.
            }
        }
    } catch (Throwable $error) {
        error_log('ark-meter: ' . $error->getMessage());
    }
    return $sent;
}

/** Which approved text a customer's country gets (phone-emails.php), and whether it has its own. */
function ark_phone_email_text(?string $country): array
{
    $emails = require __DIR__ . '/phone-emails.php';
    $country = strtoupper((string) $country);
    $language = $emails['countries'][$country] ?? null;
    if ($language === null) {
        error_log("ark-phone: no approved low-balance email for country '$country'; sent in English");
        $language = 'en';
    }
    return $emails['texts'][$language] + ['language' => $language];
}

/**
 * The one email when the last hour starts (v0.1.47), only while `phone_low_email` is on in
 * config.php (Amgad approved the text on 17 Nov; switching it on comes with his yes on the deploy).
 * From no-reply@, Reply-To General@; once per block, again only after a top-up.
 */
function ark_phone_low_email(PDO $db, string $customerId, array $view): void
{
    if (!ark_config('phone_low_email', false)) {
        return;
    }
    $find = $db->prepare('SELECT email, country, low_notified_at FROM phone_accounts WHERE customer_id = ?');
    $find->execute([$customerId]);
    $row = $find->fetch();
    if (!$row || $row['low_notified_at'] || !filter_var((string) $row['email'], FILTER_VALIDATE_EMAIL)) {
        return;
    }
    $mark = $db->prepare('UPDATE phone_accounts SET low_notified_at = ? WHERE customer_id = ? AND low_notified_at IS NULL');
    $mark->execute([ark_now(), $customerId]);
    if ($mark->rowCount() === 0) {
        return;
    }
    $text = ark_phone_email_text($row['country']);
    $body = strtr($text['body'], [
        '{minutes}' => (string) $view['minutesLeftAtLeast'],
        '{link}' => $view['topUpUrl'],
    ]);
    $from = (string) ark_config('phone_low_email_from', 'no-reply@blackark.uk');
    $replyTo = (string) ark_config('phone_low_email_reply_to', '');
    $headers = "From: $from\r\n"
        . ($replyTo !== '' ? "Reply-To: $replyTo\r\n" : '')
        . "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n";
    $subject = '=?UTF-8?B?' . base64_encode($text['subject']) . '?=';
    $encoded = chunk_split(base64_encode($body), 76, "\r\n");
    $outbox = (string) ark_config('mail_outbox_dir', '');
    if ($outbox !== '') {
        // Tests only: the message is written to a folder instead of being sent.
        file_put_contents($outbox . '/' . $customerId . '.eml', "To: {$row['email']}\r\nSubject: $subject\r\n$headers\r\n$encoded");
        return;
    }
    @mail((string) $row['email'], $subject, $encoded, $headers);
}
