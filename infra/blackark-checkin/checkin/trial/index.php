<?php
/**
 * https://blackark.uk/checkin/trial/ — the self-serve trial (Amgad, 26 Nov 2026: "the full journey
 * must be automated"; any email, verified; 7 days of Ark Team 5).
 *
 * POST {"action":"start", name, company, email, installId, language?}
 *   Always 202 {"sent":true} for a well-formed request, so nobody learns from here whether an
 *   address or a company already had a trial (the Security Engineer's review of v0.1.58, L2). The
 *   email says which: a 6-digit code good for 15 minutes, or that a trial was already used.
 *   At most TRIAL_CODES_PER_DAY codes to one address a day. 429 when asked too often.
 * POST {"action":"confirm", email, installId, code}
 *   With the right code (TRIAL_CODE_TRIES a day for that address, however many codes were sent),
 *   signs a trial activation code for a new customer id and answers {"code":"ARK1-…",…}. The same
 *   email from the same computer gets the same code again while it lasts, so a trial that could not
 *   be applied is not lost (L3).
 *
 * One per email (compared without +tags, and without dots for Gmail), per computer and per company
 * email domain; a free-mail domain (gmail.com and the like) is not a company.
 * Stored: the email, name, company, domain, install id, customer id and code of each trial, for
 * BlackArk's admin page and the one-trial rule, deleted TRIAL_KEEP_DAYS after the trial ends; a
 * pending code only as a keyed hash, for a day at most (the privacy notice).
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
const TRIAL_CODES_PER_DAY = 5;
const TRIAL_KEEP_DAYS = 730;
const FREE_MAIL = [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.gr', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.gr', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com',
    'gmx.de', 'gmx.net', 'mail.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com',
    'yandex.com', 'yandex.ru', 'otenet.gr', 'hol.gr', 'windowslive.com', 'tutanota.com', 'web.de',
    'freemail.gr', 'in.gr', 'forthnet.gr', 'forthnetgroup.gr', 'cosmotemail.gr', 'vodafone.gr',
    'yahoo.co.uk', 'hotmail.co.uk', 'live.co.uk', 'outlook.co.uk', 'btinternet.com', 'sky.com',
    'yahoo.de', 'yahoo.fr', 'yahoo.it', 'yahoo.es', 'hotmail.fr', 'hotmail.it', 'hotmail.de',
    'libero.it', 'orange.fr', 'free.fr', 't-online.de', 'mail.ru', 'qq.com', '163.com', 'fastmail.com',
    'hey.com', 'duck.com', 'mailbox.org', 'posteo.de', 'skynet.be', 'telenet.be', 'cyta.com.cy',
];

/** The address as the one-trial rule compares it: without a +tag, and without dots for Gmail. */
function trial_email_key(string $email): string
{
    [$local, $domain] = explode('@', $email, 2);
    $local = explode('+', $local, 2)[0];
    if ($domain === 'gmail.com' || $domain === 'googlemail.com') {
        $local = str_replace('.', '', $local);
        $domain = 'gmail.com';
    }
    return $local . '@' . $domain;
}

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
$emailKey = trial_email_key($email);
$domain = substr($emailKey, strrpos($emailKey, '@') + 1);
$company = in_array($domain, FREE_MAIL, true) ? null : $domain;
if (ark_selfserve_secret() === null) {
    trial_answer(503, ['error' => 'Free trials cannot be started here yet. Contact BlackArk.']);
}

$db = ark_db();
ark_selfserve_tables($db);
// Kept as long as the one-trial rule needs them (the privacy notice), pending codes for a day.
$db->prepare('DELETE FROM selfserve_trials WHERE until < ?')->execute([time() - TRIAL_KEEP_DAYS * 86400]);
$db->prepare('DELETE FROM selfserve_pending WHERE day_from < ?')->execute([time() - 86400]);

/** This address's own trial from this computer, still running: it may be fetched again (L3). */
$mine = function () use ($db, $emailKey, $install) {
    $find = $db->prepare('SELECT * FROM selfserve_trials WHERE email_key = ? AND install_id = ? AND until > ?');
    $find->execute([$emailKey, $install, time()]);
    return $find->fetch() ?: null;
};
/** Whether this email, this computer or this company already had one (other than `mine`). */
$used = function () use ($db, $emailKey, $install, $company): bool {
    $find = $db->prepare('SELECT 1 FROM selfserve_trials WHERE email_key = ? OR install_id = ?'
        . ($company !== null ? ' OR domain = ?' : '') . ' LIMIT 1');
    $find->execute($company !== null ? [$emailKey, $install, $company] : [$emailKey, $install]);
    return (bool) $find->fetchColumn();
};
$codeHash = fn (string $code): string => hash_hmac('sha256', $emailKey . '|' . $code, (string) ark_config('selfserve_trial_secret_key', ''));
$greek = ($body['language'] ?? 'el') !== 'en';

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
    $find = $db->prepare('SELECT * FROM selfserve_pending WHERE email_key = ?');
    $find->execute([$emailKey]);
    $pending = $find->fetch() ?: null;
    if ($pending && time() - (int) $pending['sent_at'] < TRIAL_RESEND_SECONDS) {
        trial_answer(429, ['error' => 'A code was just sent. Wait a minute before asking for another.']);
    }
    if ($pending && (int) $pending['codes'] >= TRIAL_CODES_PER_DAY) {
        trial_answer(429, ['error' => 'Too many codes for this address today. Try again tomorrow.']);
    }
    if ($used() && !$mine()) {
        // The same answer as a sent code (L2); the email itself says the trial was already used.
        $db->prepare('INSERT INTO selfserve_pending (email_key, install_id, name, company, code_hash, sent_at, tries, codes, day_from)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(email_key) DO UPDATE SET sent_at = excluded.sent_at, codes = codes + 1')
            ->execute([$emailKey, $install, $name, $companyName, '-', time(), TRIAL_CODE_TRIES, time()]);
        $text = "Ζητήσατε δωρεάν δοκιμή ArkAgent, αλλά έχει ήδη χρησιμοποιηθεί δοκιμή με αυτό το email, σε αυτόν τον υπολογιστή ή για την εταιρεία σας. Για να συνεχίσετε, αγοράστε άδεια μέσα από το ArkAgent ή επικοινωνήστε με την BlackArk.\n\n---\n\n"
            . "You asked for a free ArkAgent trial, but a trial was already used with this email, on this computer, or for your company. To continue, buy a licence in ArkAgent or contact BlackArk.";
        ark_send_mail($email, $greek ? 'Δοκιμή ArkAgent' : 'Your ArkAgent trial', $text, $greek ? 'el' : 'en', 'trial-' . $install);
        trial_answer(202, ['sent' => true]);
    }
    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    // A new code keeps the day's wrong tries (L1): asking again does not buy more guesses.
    $db->prepare('INSERT INTO selfserve_pending (email_key, install_id, name, company, code_hash, sent_at, tries, codes, day_from)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)
        ON CONFLICT(email_key) DO UPDATE SET install_id = excluded.install_id, name = excluded.name, company = excluded.company,
            code_hash = excluded.code_hash, sent_at = excluded.sent_at, codes = codes + 1')
        ->execute([$emailKey, $install, $name, $companyName, $codeHash($code), time(), time()]);
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
    $find = $db->prepare('SELECT * FROM selfserve_pending WHERE email_key = ? AND install_id = ?');
    $find->execute([$emailKey, $install]);
    $row = $find->fetch();
    if (!$row || time() - (int) $row['sent_at'] > TRIAL_CODE_SECONDS || $row['code_hash'] === '-') {
        trial_answer(400, ['error' => 'This code has run out. Ask for a new one.', 'code' => 'expired']);
    }
    if ((int) $row['tries'] >= TRIAL_CODE_TRIES) {
        trial_answer(400, ['error' => 'Too many wrong codes. Try again tomorrow.', 'code' => 'expired']);
    }
    if (strlen($typed) !== 6 || !hash_equals((string) $row['code_hash'], $codeHash($typed))) {
        $db->prepare('UPDATE selfserve_pending SET tries = tries + 1 WHERE email_key = ?')->execute([$emailKey]);
        trial_answer(400, ['error' => 'That code is not right. Check the email and try again.', 'code' => 'wrong']);
    }
    $db->prepare("UPDATE selfserve_pending SET code_hash = '-' WHERE email_key = ?")->execute([$emailKey]);
    $again = $mine();
    if ($again) {
        // The same trial again, for the same address and computer (L3): never a second one.
        trial_answer(200, ['code' => $again['code'], 'customerId' => $again['customer_id'], 'until' => gmdate('c', (int) $again['until'])]);
    }
    if ($used()) {
        trial_answer(409, ['error' => 'A free trial was already used with this email, on this computer, or for this company. To continue, buy a licence or contact BlackArk.', 'code' => 'trial_used']);
    }
    $customer = trial_customer_id($db, (string) $row['company']);
    $signed = ark_sign_selfserve_trial($customer);
    if ($signed === null) {
        trial_answer(503, ['error' => 'Free trials cannot be started here yet. Contact BlackArk.']);
    }
    $db->prepare('INSERT INTO selfserve_trials (email_key, email, install_id, domain, customer_id, name, company, code, issued_at, until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([
        $emailKey, $email, $install, $company, $customer, $row['name'], $row['company'], $signed['code'], time(), strtotime($signed['until']),
    ]);
    trial_answer(200, ['code' => $signed['code'], 'customerId' => $customer, 'until' => $signed['until']]);
}

trial_answer(400, ['error' => 'Not a trial request.']);
