<?php
/**
 * https://blackark.uk/checkin/key/?session_id=cs_… — where Stripe sends a customer after paying
 * (#109, v0.1.44). Shows their ArkAgent licence key to copy, once the webhook has signed it. The
 * checkout session id, which only the paying browser has, is what finds it. For two days after
 * payment (v0.1.57): the link stays in the browser's history.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

ark_send_security_headers();
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');

$session = (string) ($_GET['session_id'] ?? '');
$row = null;
if (preg_match('/^cs_[A-Za-z0-9_]{10,200}$/', $session) === 1) {
    $find = ark_db()->prepare('SELECT license_key, valid_until, plan, held, session_at FROM licenses WHERE session_id = ?');
    $find->execute([$session]);
    $row = $find->fetch() ?: null;
}
function h($text): string
{
    return htmlspecialchars((string) $text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
// The link is in the browser's history, so it shows the key for two days only (v0.1.57). After
// that ArkAgent has fetched the key by itself, and a person who still needs it asks BlackArk.
$gone = $row && (int) ($row['session_at'] ?? 0) + ARK_KEY_PAGE_SECONDS < time();
$ready = $row && !$gone && $row['license_key'];
$held = $row && !$ready && (int) $row['held'] === 1;
echo ark_page_open('ArkAgent licence key', 'el', $ready || $held || $gone ? '' : '<meta http-equiv="refresh" content="10">');
?>
<?php if ($gone): ?>
  <h1>Αυτή η σελίδα έληξε</h1>
  <p>Το ArkAgent παίρνει μόνο του το κλειδί άδειας μετά την πληρωμή. Αν χρειάζεστε το κλειδί, επικοινωνήστε με την BlackArk από τη Βοήθεια και υποστήριξη του ArkAgent.</p>
  <p lang="en">This page has expired. ArkAgent fetches its licence key by itself after payment. If you need the key, contact BlackArk from ArkAgent's Help &amp; support.</p>
<?php elseif ($ready): ?>
  <h1>Ευχαριστούμε! Το κλειδί άδειας ArkAgent</h1>
  <p>Αντιγράψτε το παρακάτω κλειδί και επικολλήστε το στο ArkAgent, στην οθόνη «Ενεργοποίηση ArkAgent» ή στις Ρυθμίσεις, Πρόγραμμα, Ενεργοποίηση.</p>
  <textarea class="key" readonly aria-label="Licence key"><?= h($row['license_key']) ?></textarea>
  <p>Ισχύει έως <?= h(substr((string) $row['valid_until'], 0, 10)) ?>. Κάθε μήνα το ArkAgent παίρνει μόνο του το ανανεωμένο κλειδί.</p>
  <hr>
  <p lang="en">Thank you. Copy this key into ArkAgent's Activate screen, or Settings, Plan, Activation. It renews by itself each month.</p>
<?php elseif ($row && (int) $row['held'] === 1): ?>
  <h1>Η αγορά σας ελέγχεται</h1>
  <p>Η πληρωμή ολοκληρώθηκε. Η BlackArk ελέγχει αυτή την αγορά πριν εκδοθεί το κλειδί, γιατί ο σύνδεσμος δεν επιβεβαιώθηκε από το ArkAgent ή ο κωδικός πελάτη ανήκει ήδη σε άλλο λογαριασμό. Επικοινωνεί μαζί σας, συνήθως την ίδια εργάσιμη μέρα. Αν δεν είναι δική σας η αγορά, θα επιστραφούν τα χρήματα.</p>
  <p lang="en">Your payment went through. BlackArk checks this purchase before the key is issued, because the link was not confirmed by ArkAgent or the customer id in it already belongs to another account. BlackArk contacts you, usually the same working day. If it is not yours, the payment is refunded.</p>
<?php else: ?>
  <h1>Το κλειδί σας ετοιμάζεται…</h1>
  <p>Η πληρωμή ολοκληρώθηκε. Η σελίδα ανανεώνεται μόνη της σε λίγα δευτερόλεπτα. Αν δεν εμφανιστεί κλειδί σε 5 λεπτά, επικοινωνήστε με την BlackArk.</p>
  <p lang="en">Your key is being prepared. This page refreshes by itself. If no key appears within 5 minutes, contact BlackArk.</p>
<?php endif; ?>
<?= ark_page_close() ?>
