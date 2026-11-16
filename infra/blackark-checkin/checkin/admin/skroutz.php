<?php
/**
 * https://blackark.uk/checkin/admin/skroutz.php — Skroutz order inboxes (#109, v0.1.43), staff only.
 *
 * One inbox per customer install. Creating one shows, ONCE:
 * - the webhook address, which the customer pastes into the Skroutz merchant panel;
 * - the inbox key, which the on-site installer types into ArkAgent, Settings, Connect your Data,
 *   Skroutz. Only its SHA-256 is kept here, so a lost key means a new inbox.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

ark_send_security_headers();
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
session_name('ark_checkin_admin');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/checkin/admin/',
    'secure' => $secure,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

if (empty($_SESSION['signed_in'])) {
    header('Location: ./');
    exit;
}

function h($text): string
{
    return htmlspecialchars((string) $text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function token(int $bytes): string
{
    return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
}

$db = ark_db();
$csrf = (string) ($_SESSION['csrf'] ?? '');
$created = null;
$error = '';
$posted = ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST';
if ($posted && !hash_equals($csrf, (string) ($_POST['csrf'] ?? ''))) {
    $error = 'The form expired. Reload the page and try again.';
} elseif ($posted && ($_POST['action'] ?? '') === 'create') {
    $label = trim((string) ($_POST['label'] ?? ''));
    if (preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $label) !== 1) {
        $error = 'The label is the customer id: lower-case letters, numbers and hyphens.';
    } else {
        $inbox = token(24);
        $secret = token(32);
        $db->prepare('INSERT INTO skroutz_inboxes (inbox_id, label, secret_sha256, created_at) VALUES (?, ?, ?, ?)')
            ->execute([$inbox, $label, hash('sha256', $secret), ark_now()]);
        $host = (string) ($_SERVER['HTTP_HOST'] ?? 'blackark.uk');
        $created = [
            'label' => $label,
            'url' => 'https://' . $host . '/checkin/skroutz/?inbox=' . $inbox,
            'secret' => $secret,
        ];
    }
} elseif ($posted && ($_POST['action'] ?? '') === 'delete') {
    $inbox = (string) ($_POST['inbox'] ?? '');
    $db->prepare('DELETE FROM skroutz_events WHERE inbox_id = ?')->execute([$inbox]);
    $db->prepare('DELETE FROM skroutz_inboxes WHERE inbox_id = ?')->execute([$inbox]);
}

$rows = $db->query('SELECT i.inbox_id, i.label, i.created_at, i.last_event_at, i.last_collect_at,
    (SELECT COUNT(*) FROM skroutz_events e WHERE e.inbox_id = i.inbox_id) AS waiting
    FROM skroutz_inboxes i ORDER BY i.label')->fetchAll();
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Skroutz order inboxes</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 24px 16px; color: #1d1d1f; background: #fafafa; }
  main { max-width: 1000px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; }
  .box { background: #fff; border: 1px solid #e5e5e5; padding: 16px; margin: 16px 0; }
  code { word-break: break-all; }
  .error { color: #b3261e; }
</style>
</head>
<body>
<main>
  <p><a href="./">← Trial check-ins</a></p>
  <h1>Skroutz order inboxes</h1>
  <p>Skroutz sends each new or changed order here; the customer's ArkAgent collects it and it is deleted. Nothing waits longer than 7 days.</p>
  <?php if ($error !== ''): ?><p class="error" role="alert"><?= h($error) ?></p><?php endif; ?>
  <?php if ($created): ?>
    <div class="box" role="status">
      <strong>Inbox for <?= h($created['label']) ?>. Copy both now: the key is not shown again.</strong>
      <p>Webhook address, for the Skroutz merchant panel (Smart Cart settings):<br><code><?= h($created['url']) ?></code></p>
      <p>Inbox key, for ArkAgent (Settings, Connect your Data, Skroutz, Order inbox key):<br><code><?= h($created['secret']) ?></code></p>
    </div>
  <?php endif; ?>
  <form class="box" method="post">
    <label>Customer id <input name="label" required pattern="[a-z0-9][a-z0-9-]{1,63}"></label>
    <input type="hidden" name="action" value="create">
    <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
    <button type="submit">Create inbox</button>
  </form>
  <table>
    <tr><th>Customer</th><th>Created</th><th>Last order event</th><th>Last collected</th><th>Waiting</th><th></th></tr>
    <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= h($row['label']) ?></td>
        <td><?= h($row['created_at']) ?></td>
        <td><?= h($row['last_event_at'] ?? '–') ?></td>
        <td><?= h($row['last_collect_at'] ?? '–') ?></td>
        <td><?= h($row['waiting']) ?></td>
        <td>
          <form method="post" onsubmit="return confirm('Delete this inbox? Skroutz orders will stop reaching that install.')">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="inbox" value="<?= h($row['inbox_id']) ?>">
            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
            <button type="submit">Delete</button>
          </form>
        </td>
      </tr>
    <?php endforeach; ?>
  </table>
</main>
</body>
</html>
