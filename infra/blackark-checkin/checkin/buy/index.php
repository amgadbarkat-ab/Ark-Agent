<?php
/**
 * https://blackark.uk/checkin/buy/ — opens a Stripe Checkout (#109, v0.1.47; Amgad 17 Nov).
 *
 *   ?customer=<id>&phone=1   the team plan, the phone add-on and the first prepaid 5-hour block, so
 *                            the customer sees every price, per-minute ones included, before paying
 *   ?customer=<id>           the team plan alone
 *   ?customer=<id>&topup=1   one more 5-hour block for the phone balance (a one-off payment)
 *   ?done=1                  where a top-up returns after paying
 *
 * The customer id is the ArkAgent one (lower-case letters, digits, hyphens), carried to Stripe as
 * client_reference_id so the webhook knows whose key and balance it is. Stripe's restricted key and
 * the price ids are in config.php. Nothing is stored here: the webhook does that once Stripe says paid.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

ark_send_security_headers();
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function h($text): string
{
    return htmlspecialchars((string) $text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function page(int $status, string $title, string $greek, string $english): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html lang="el"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">'
        . '<title>' . h($title) . '</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 16px;color:#1d1d1f;background:#fafafa}main{max-width:640px;margin:0 auto}</style>'
        . '</head><body><main><h1>' . h($title) . '</h1><p>' . h($greek) . '</p><p lang="en">' . h($english) . '</p></main></body></html>';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET');
    page(405, 'ArkAgent', 'Μη αποδεκτό αίτημα.', 'Not accepted.');
}
if (isset($_GET['done'])) {
    page(200, 'Ευχαριστούμε!', 'Η πληρωμή ολοκληρώθηκε. Οι 5 ώρες προστίθενται στο υπόλοιπο τηλεφωνίας σε λίγα λεπτά και εμφανίζονται στο ArkAgent.', 'Thank you. The 5 hours are added to the phone balance within a few minutes and show in ArkAgent.');
}

$customer = strtolower(trim((string) ($_GET['customer'] ?? '')));
if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $customer) !== 1) {
    page(400, 'ArkAgent', 'Λείπει ο κωδικός πελάτη από τον σύνδεσμο. Επικοινωνήστε με την BlackArk.', 'The link is missing the customer id. Contact BlackArk.');
}
$prices = (array) ark_config('stripe_buy', []);
$topup = isset($_GET['topup']);
$phone = $topup || isset($_GET['phone']);
$base = rtrim((string) ark_config('public_base_url', 'https://blackark.uk/checkin'), '/');

if ($topup) {
    // Only for a customer who has the phone add-on: a balance nobody can use helps no one.
    $db = ark_db();
    $known = $db->prepare("SELECT 1 FROM phone_accounts WHERE customer_id = ?
        UNION SELECT 1 FROM licenses WHERE customer_id = ? AND status = 'active' AND (',' || addons || ',') LIKE '%,phone,%'");
    $known->execute([$customer, $customer]);
    if (!$known->fetchColumn()) {
        page(404, 'ArkAgent', 'Δεν βρέθηκε πρόσθετο τηλεφωνίας για αυτόν τον πελάτη.', 'No phone add-on was found for this customer.');
    }
}

$items = [];
if (!$topup) {
    $items[] = (string) ($prices['plan'] ?? '');
}
if ($phone && !$topup) {
    $items[] = (string) ($prices['phone'] ?? '');
}
if ($phone) {
    $items[] = (string) ($prices['block'] ?? '');
}
foreach ($items as $price) {
    if (preg_match('/^price_[A-Za-z0-9]{1,80}$/', $price) !== 1) {
        page(503, 'ArkAgent', 'Οι αγορές δεν είναι ακόμη διαθέσιμες.', 'Buying is not available yet.');
    }
}

$form = [
    'mode' => $topup ? 'payment' : 'subscription',
    'client_reference_id' => $customer,
    'success_url' => $topup ? $base . '/buy/?done=1' : $base . '/key/?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url' => (string) ark_config('buy_cancel_url', 'https://blackark.uk/'),
    'locale' => 'el',
    'metadata' => ['kind' => $topup ? 'phone_topup' : 'subscription', 'phone_blocks' => $phone ? '1' : '0'],
];
foreach (array_values($items) as $index => $price) {
    $form['line_items'][$index] = ['price' => $price, 'quantity' => 1];
}
if (ark_config('stripe_automatic_tax', false)) {
    $form['automatic_tax'] = ['enabled' => 'true'];
}
$session = ark_stripe_api('/v1/checkout/sessions', $form);
$url = is_array($session) ? (string) ($session['url'] ?? '') : '';
if (strpos($url, 'https://checkout.stripe.com/') !== 0) {
    error_log('ark-buy: Stripe did not open a checkout: ' . json_encode($session['error']['message'] ?? 'no answer'));
    page(502, 'ArkAgent', 'Η σελίδα πληρωμής δεν άνοιξε. Δοκιμάστε ξανά σε λίγο.', 'The payment page did not open. Try again shortly.');
}
header('Location: ' . $url, true, 303);
