<?php
/**
 * https://blackark.uk/checkin/key/?session_id=cs_… — where Stripe sends a customer after paying
 * (#109, v0.1.44). Shows their ArkAgent licence key to copy, once the webhook has signed it. The
 * checkout session id, which only the paying browser has, is what finds it.
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
    $find = ark_db()->prepare('SELECT license_key, valid_until, plan FROM licenses WHERE session_id = ?');
    $find->execute([$session]);
    $row = $find->fetch() ?: null;
}
function h($text): string
{
    return htmlspecialchars((string) $text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
?><!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<?php if (!$row || !$row['license_key']): ?><meta http-equiv="refresh" content="10"><?php endif; ?>
<title>ArkAgent licence key</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 32px 16px; color: #1d1d1f; background: #fafafa; }
  main { max-width: 640px; margin: 0 auto; }
  textarea { width: 100%; box-sizing: border-box; min-height: 9em; font: 13px/1.4 ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<?php if ($row && $row['license_key']): ?>
  <h1>Ευχαριστούμε! Το κλειδί άδειας ArkAgent</h1>
  <p>Αντιγράψτε το παρακάτω κλειδί και επικολλήστε το στο ArkAgent, στην οθόνη «Ενεργοποίηση ArkAgent» ή στις Ρυθμίσεις, Πρόγραμμα, Ενεργοποίηση.</p>
  <textarea readonly onclick="this.select()"><?= h($row['license_key']) ?></textarea>
  <p>Ισχύει έως <?= h(substr((string) $row['valid_until'], 0, 10)) ?>. Κάθε μήνα το ArkAgent παίρνει μόνο του το ανανεωμένο κλειδί.</p>
  <hr>
  <p lang="en">Thank you. Copy this key into ArkAgent's Activate screen, or Settings, Plan, Activation. It renews by itself each month.</p>
<?php else: ?>
  <h1>Το κλειδί σας ετοιμάζεται…</h1>
  <p>Η πληρωμή ολοκληρώθηκε. Η σελίδα ανανεώνεται μόνη της σε λίγα δευτερόλεπτα. Αν δεν εμφανιστεί κλειδί σε 5 λεπτά, επικοινωνήστε με την BlackArk.</p>
  <p lang="en">Your key is being prepared. This page refreshes by itself. If no key appears within 5 minutes, contact BlackArk.</p>
<?php endif; ?>
</main>
</body>
</html>
