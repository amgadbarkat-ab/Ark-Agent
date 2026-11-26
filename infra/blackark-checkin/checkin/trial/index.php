<?php
/**
 * https://blackark.uk/checkin/trial/ — the self-serve trial (Amgad, 26 Nov 2026: "the full journey
 * must be automated"; any email, verified; 7 days of Ark Team 5).
 *
 * POST {"action":"start", name, company, email, installId, language?}
 *   Emails a 6-digit code to that address, good for 15 minutes. 202 {"sent":true}.
 *   409 {"code":"trial_used"} when this email, this computer, or this company's own email domain
 *   already had a self-serve trial. 429 when asked too often.
 * POST {"action":"confirm", email, installId, code}
 *   With the right code (5 tries), signs a trial activation code for a new customer id and answers
 *   {"code":"ARK1-…","customerId":…,"until":…}. The app applies it at once.
 *
 * A free-mail domain (gmail.com and the like) is not a company: the one-per-domain rule skips it.
 * Stored: the email, name, company, domain, the install id and the customer id of each trial, for
 * BlackArk's admin page and the one-trial rule; a pending code only as a keyed hash, for 15 minutes.
 * 503 until `selfserve_trial_secret_key` is set in config.php.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

const TRIAL_CODE_SECONDS = 900;
const TRIAL_CODE_TRIES = 5;
const TRIAL_RESEND_SECONDS = 60;
const FREE_MAIL = [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.gr', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.gr', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com',
    'gmx.de', 'gmx.net', 'mail.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com',
    'yandex.com', 'yandex.ru', 'otenet.gr', 'hol.gr', 'windowslive.com', 'tutanota.com', 'web.de',
];

function trial_answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo $body ? json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
    exit;
}

/** Plain text a person typed: no control characters, trimmed, at most `max` characters. */
function trial_text($value, int $max): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $clean = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? '');
    return $clean === '' || mb_strlen($clean) > $max ? null : $clean;
}

/** A customer id from the company's name, as the app accepts one: e.g. "wine24-k3f9". */
function trial_customer_id(PDO $db, string $company): string
{
    // Greek first, letter by letter (iconv cannot be trusted with it on every host), then the rest.
    $greek = [
        'ου' => 'ou', 'ού' => 'ou', 'α' => 'a', 'ά' => 'a', 'β' => 'v', 'γ' => 'g', 'δ' => 'd', 'ε' => 'e', 'έ' => 'e', 'ζ' => 'z',
        'η' => 'i', 'ή' => 'i', 'θ' => 'th', 'ι' => 'i', 'ί' => 'i', 'ϊ' => 'i', 'ΐ' => 'i', 'κ' => 'k',
        'λ' => 'l', 'μ' => 'm', 'ν' => 'n', 'ξ' => 'x', 'ο' => 'o', 'ό' => 'o', 'π' => 'p', 'ρ' => 'r',
        'σ' => 's', 'ς' => 's', 'τ' => 't', 'υ' => 'y', 'ύ' => 'y', 'ϋ' => 'y', 'ΰ' => 'y', 'φ' => 'f',
        'χ' => 'ch', 'ψ' => 'ps', 'ω' => 'o', 'ώ' => 'o',
    ];
    $lower = mb_strtolower($company, 'UTF-8');
    $latin = strtr($lower, $greek);
    $ascii = strtolower((string) (function_exists('iconv') ? (@iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $latin) ?: $latin) : $latin));
    $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', $ascii), '-');
    $slug = substr($slug !== '' ? $slug : 'company', 0, 40);
    if (preg_match('/^[a-z0-9]/', $slug) !== 1) {
        $slug = 'c' . $slug;
    }
    $taken = $db->prepare('SELECT 1 FROM selfserve_trials WHERE customer_id = ?
        UNION SELECT 1 FROM licenses WHERE customer_id = ? UNION SELECT 1 FROM installs WHERE customer_id = ?');
    for ($i = 0; $i < 20; $i++) {
        $id = rtrim($slug, '-') . '-' . substr(base_convert(bin2hex(random_bytes(4)), 16, 36), 0, 5);
        $taken->execute([$id, $id, $id]);
        if (!$taken->fetchColumn()) {
            return $id;
        }
    }
    return 'c-' . bin2hex(random_bytes(6));
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    trial_answer(405);
}
$raw = (string) file_get_contents('php://input', false, null, 0, 16385);
$body = strlen($raw) > 16384 ? null : json_decode($raw, true);
if (!is_array($body)) {
    trial_answer(400);
}
$install = (string) ($body['installId'] ?? '');
if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $install) !== 1) {
    trial_answer(400, ['error' => 'Not an ArkAgent install.']);
}
$email = strtolower(trim((string) ($body['email'] ?? '')));
if (strlen($email) > 200 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    trial_answer(400, ['error' => 'Write a valid email address.', 'code' => 'email']);
}
$domain = substr($email, strrpos($email, '@') + 1);
$company = in_array($domain, FREE_MAIL, true) ? null : $domain;
if (ark_selfserve_secret() === null) {
    trial_answer(503, ['error' => 'Free trials cannot be started here yet. Contact BlackArk.']);
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS selfserve_trials (
    email TEXT PRIMARY KEY, install_id TEXT NOT NULL, domain TEXT, customer_id TEXT NOT NULL,
    name TEXT NOT NULL, company TEXT NOT NULL, issued_at INTEGER NOT NULL, until INTEGER NOT NULL)');
$db->exec('CREATE INDEX IF NOT EXISTS selfserve_trials_install ON selfserve_trials (install_id)');
$db->exec('CREATE INDEX IF NOT EXISTS selfserve_trials_domain ON selfserve_trials (domain)');
$db->exec('CREATE TABLE IF NOT EXISTS selfserve_pending (
    email TEXT PRIMARY KEY, install_id TEXT NOT NULL, name TEXT NOT NULL, company TEXT NOT NULL,
    code_hash TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)');
$db->prepare('DELETE FROM selfserve_pending WHERE sent_at < ?')->execute([time() - TRIAL_CODE_SECONDS]);

/** Whether this email, this computer or this company already had one. */
$used = function () use ($db, $email, $install, $company): bool {
    $find = $db->prepare('SELECT 1 FROM selfserve_trials WHERE email = ? OR install_id = ?'
        . ($company !== null ? ' OR domain = ?' : '') . ' LIMIT 1');
    $find->execute($company !== null ? [$email, $install, $company] : [$email, $install]);
    return (bool) $find->fetchColumn();
};
$codeHash = fn (string $code): string => hash_hmac('sha256', $email . '|' . $code, (string) ark_config('selfserve_trial_secret_key', ''));

$action = (string) ($body['action'] ?? '');
if ($action === 'start') {
    if (!ark_request_allowed($db, 'trial_start', $install, 5, 20)) {
        trial_answer(429, ['error' => 'Too many tries. Wait an hour and try again.']);
    }
    $name = trial_text($body['name'] ?? null, 100);
    $companyName = trial_text($body['company'] ?? null, 120);
    if ($name === null || $companyName === null) {
        trial_answer(400, ['error' => 'Write your name and your company.', 'code' => 'name']);
    }
    if ($used()) {
        trial_answer(409, [
            'error' => 'A free trial was already used with this email, on this computer, or for this company. To continue, buy a licence or contact BlackArk.',
            'code' => 'trial_used',
        ]);
    }
    $pending = $db->prepare('SELECT sent_at FROM selfserve_pending WHERE email = ?');
    $pending->execute([$email]);
    $sent = $pending->fetchColumn();
    if ($sent !== false && time() - (int) $sent < TRIAL_RESEND_SECONDS) {
        trial_answer(429, ['error' => 'A code was just sent. Wait a minute before asking for another.']);
    }
    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $db->prepare('INSERT OR REPLACE INTO selfserve_pending (email, install_id, name, company, code_hash, tries, sent_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)')->execute([$email, $install, $name, $companyName, $codeHash($code), time()]);
    $greek = ($body['language'] ?? 'el') !== 'en';
    $text = "Ο κωδικός σας για τη δωρεάν δοκιμή ArkAgent είναι: $code\n\n"
        . "Πληκτρολογήστε τον στο ArkAgent μέσα σε 15 λεπτά. Αν δεν ζητήσατε δοκιμή, αγνοήστε αυτό το μήνυμα.\n\n---\n\n"
        . "Your ArkAgent free trial code is: $code\n\n"
        . "Type it into ArkAgent within 15 minutes. If you did not ask for a trial, ignore this email.";
    ark_send_mail($email, $greek ? 'Ο κωδικός δοκιμής ArkAgent' : 'Your ArkAgent trial code', $text, $greek ? 'el' : 'en', 'trial-' . $install);
    trial_answer(202, ['sent' => true]);
}

if ($action === 'confirm') {
    if (!ark_request_allowed($db, 'trial_confirm', $install, 20, 60)) {
        trial_answer(429, ['error' => 'Too many tries. Wait an hour and try again.']);
    }
    $typed = preg_replace('/\D+/', '', (string) ($body['code'] ?? ''));
    $find = $db->prepare('SELECT * FROM selfserve_pending WHERE email = ? AND install_id = ?');
    $find->execute([$email, $install]);
    $row = $find->fetch();
    if (!$row) {
        trial_answer(400, ['error' => 'This code has run out. Ask for a new one.', 'code' => 'expired']);
    }
    if ((int) $row['tries'] >= TRIAL_CODE_TRIES) {
        $db->prepare('DELETE FROM selfserve_pending WHERE email = ?')->execute([$email]);
        trial_answer(400, ['error' => 'Too many wrong codes. Ask for a new one.', 'code' => 'expired']);
    }
    if (strlen($typed) !== 6 || !hash_equals((string) $row['code_hash'], $codeHash($typed))) {
        $db->prepare('UPDATE selfserve_pending SET tries = tries + 1 WHERE email = ?')->execute([$email]);
        trial_answer(400, ['error' => 'That code is not right. Check the email and try again.', 'code' => 'wrong']);
    }
    if ($used()) {
        trial_answer(409, ['error' => 'A free trial was already used with this email, on this computer, or for this company.', 'code' => 'trial_used']);
    }
    $customer = trial_customer_id($db, (string) $row['company']);
    $signed = ark_sign_selfserve_trial($customer);
    if ($signed === null) {
        trial_answer(503, ['error' => 'Free trials cannot be started here yet. Contact BlackArk.']);
    }
    $db->prepare('INSERT INTO selfserve_trials (email, install_id, domain, customer_id, name, company, issued_at, until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)')->execute([
        $email, $install, $company, $customer, $row['name'], $row['company'], time(), strtotime($signed['until']),
    ]);
    $db->prepare('DELETE FROM selfserve_pending WHERE email = ?')->execute([$email]);
    trial_answer(200, ['code' => $signed['code'], 'customerId' => $customer, 'until' => $signed['until']]);
}

trial_answer(400, ['error' => 'Not a trial request.']);
