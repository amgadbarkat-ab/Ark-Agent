<?php
/**
 * https://blackark.uk/checkin/admin/ — the trial status page (#109), behind a password.
 *
 * One row per install: customer, version, status, days left, end, employees, whether the last
 * check-in carried a BlackArk-signed profile, and when it was last heard from. A customer seen on
 * more than one install in the last 7 days is flagged.
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

function h($text): string
{
    return htmlspecialchars((string) $text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function athens(?string $iso): string
{
    if (!$iso) {
        return '–';
    }
    try {
        $time = new DateTime($iso);
        $time->setTimezone(new DateTimeZone('Europe/Athens'));
        return $time->format('d/m/Y H:i');
    } catch (Throwable $error) {
        return h($iso);
    }
}

$db = ark_db();
$error = '';

if (($_POST['action'] ?? '') === 'logout' && hash_equals($_SESSION['csrf'] ?? '', (string) ($_POST['csrf'] ?? ''))) {
    $_SESSION = [];
    session_destroy();
    header('Location: ./');
    exit;
}

if (($_POST['action'] ?? '') === 'login') {
    $window = time() - 900;
    $db->prepare('DELETE FROM login_failures WHERE at < ?')->execute([$window]);
    $failures = (int) $db->query('SELECT COUNT(*) FROM login_failures')->fetchColumn();
    $hash = (string) ark_config('admin_password_hash', '');
    if ($failures >= 10) {
        $error = 'Too many wrong passwords. Try again in 15 minutes.';
    } elseif (
        !hash_equals($_SESSION['csrf'] ?? '', (string) ($_POST['csrf'] ?? '')) ||
        $hash === '' ||
        !password_verify((string) ($_POST['password'] ?? ''), $hash)
    ) {
        $db->prepare('INSERT INTO login_failures (at) VALUES (?)')->execute([time()]);
        sleep(1);
        $error = 'Wrong password.';
    } else {
        session_regenerate_id(true);
        $_SESSION['signed_in'] = true;
        header('Location: ./');
        exit;
    }
}

if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
}
$csrf = $_SESSION['csrf'];
$signedIn = !empty($_SESSION['signed_in']);

?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Trial check-ins</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 24px 16px; color: #1d1d1f; background: #fafafa; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.note { color: #555; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; white-space: nowrap; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  .wrap { overflow-x: auto; }
  .flag { color: #b3261e; font-weight: 600; }
  .ok { color: #1b6e2e; }
  .muted { color: #888; }
  form.login { max-width: 320px; background: #fff; padding: 20px; border: 1px solid #e5e5e5; }
  input[type=password] { width: 100%; padding: 8px; margin: 8px 0 12px; box-sizing: border-box; }
  button { padding: 8px 14px; }
  .error { color: #b3261e; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
</style>
</head>
<body>
<main>
<?php if (!$signedIn): ?>
  <h1>Trial check-ins</h1>
  <p class="note">BlackArk staff only.</p>
  <form class="login" method="post" action="./">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <input type="hidden" name="action" value="login">
    <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
    <button type="submit">Sign in</button>
    <?php if ($error !== ''): ?><p class="error" role="alert"><?= h($error) ?></p><?php endif; ?>
  </form>
<?php else:
    $rows = $db->query('SELECT * FROM installs ORDER BY customer_id, last_seen DESC')->fetchAll();
    $recent = gmdate('Y-m-d\TH:i:s\Z', time() - 7 * 86400);
    $perCustomer = [];
    foreach ($rows as $row) {
        if ($row['last_seen'] >= $recent) {
            $perCustomer[$row['customer_id']] = ($perCustomer[$row['customer_id']] ?? 0) + 1;
        }
    }
?>
  <header>
    <div>
      <h1>Trial check-ins</h1>
      <p class="note"><?= count($rows) ?> installs. Times are Athens time. Each install reports once a day; nothing about conversations is sent.</p>
      <p class="note"><a href="skroutz.php">Skroutz order inboxes</a></p>
    </div>
    <form method="post" action="./">
      <input type="hidden" name="action" value="logout">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
      <button type="submit">Sign out</button>
    </form>
  </header>
  <div class="wrap">
  <table>
    <thead><tr>
      <th>Customer</th><th>Install</th><th>Version</th><th>Status</th><th>Days left</th>
      <th>Ends</th><th>Employees</th><th>Signed profile</th><th>Last check-in</th><th>First seen</th><th>Check-ins</th>
    </tr></thead>
    <tbody>
    <?php if (!$rows): ?>
      <tr><td colspan="11" class="muted">No install has checked in yet.</td></tr>
    <?php endif; ?>
    <?php foreach ($rows as $row):
        $second = ($perCustomer[$row['customer_id']] ?? 0) > 1;
        $stale = $row['last_seen'] < gmdate('Y-m-d\TH:i:s\Z', time() - 2 * 86400);
    ?>
      <tr>
        <td><?= h($row['customer_id']) ?><?php if ($second): ?> <span class="flag" title="More than one install of this customer checked in during the last 7 days">· second install</span><?php endif; ?></td>
        <td class="muted"><?= h(substr($row['install_id'], 0, 8)) ?>…</td>
        <td><?= h($row['version']) ?></td>
        <td><?= h($row['status']) ?></td>
        <td><?= (int) $row['days_left'] ?></td>
        <td><?= athens($row['ends_at']) ?></td>
        <td><?= $row['employees'] === null ? '–' : (int) $row['employees'] ?></td>
        <td><?= ((int) $row['verified']) === 1 ? '<span class="ok">verified</span>' : '<span class="muted">unverified</span>' ?></td>
        <td<?= $stale ? ' class="flag" title="Not heard from in over 2 days"' : '' ?>><?= athens($row['last_seen']) ?></td>
        <td><?= athens($row['first_seen']) ?></td>
        <td><?= (int) $row['checkins'] ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
  </div>
<?php endif; ?>
</main>
</body>
</html>
