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
    $pdo->exec('CREATE TABLE IF NOT EXISTS login_failures (at INTEGER NOT NULL)');
    // Skroutz order inboxes (v0.1.43): one per customer install; events wait here until collected.
    $pdo->exec('CREATE TABLE IF NOT EXISTS skroutz_inboxes (
        inbox_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        secret_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_event_at TEXT,
        last_collect_at TEXT
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS skroutz_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inbox_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        body TEXT NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS skroutz_events_inbox ON skroutz_events (inbox_id, id)');
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
    $pdo->exec('CREATE TABLE IF NOT EXISTS stripe_events (event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL)');
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
function ark_sign_license(string $customerId, string $plan, int $seats, array $addons, int $periodEnd): ?array
{
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
