<?php
/**
 * https://blackark.uk/checkin/admin/ — the trial status page (#109), behind a password.
 *
 * One row per install: customer, version, status, days left, end, employees, whether the last
 * check-in carried a BlackArk-signed profile, and when it was last heard from. A customer seen on
 * more than one install in the last 7 days is flagged.
 *
 * Ark Private Server orders (#149, 19 Nov): each paid order, and the form where staff attach the server
 * once it is set up (its https address ending in /v1, the model it serves and its key), or mark it
 * stopped. The key is written once and never shown again here; the customer's install fetches it from
 * servers/ with its own proof.
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
    $address = ark_address_key(); // a keyed hash, never the address itself (v0.1.57)
    $db->prepare('DELETE FROM login_failures WHERE at < ?')->execute([$window]);
    // Per address (security assessment of 26 Nov 2026): 10 wrong in 15 minutes locks that address,
    // so somebody else's guesses cannot lock BlackArk out. 200 from everywhere still locks all.
    $mine = $db->prepare('SELECT COUNT(*) FROM login_failures WHERE address = ?');
    $mine->execute([$address]);
    $failures = (int) $mine->fetchColumn();
    $everyone = (int) $db->query('SELECT COUNT(*) FROM login_failures')->fetchColumn();
    $hash = (string) ark_config('admin_password_hash', '');
    if ($failures >= 10 || $everyone >= 200) {
        $error = 'Too many wrong passwords. Try again in 15 minutes.';
    } elseif (
        !hash_equals($_SESSION['csrf'] ?? '', (string) ($_POST['csrf'] ?? '')) ||
        $hash === '' ||
        !password_verify((string) ($_POST['password'] ?? ''), $hash)
    ) {
        $db->prepare('INSERT INTO login_failures (at, address) VALUES (?, ?)')->execute([time(), $address]);
        sleep(1);
        $error = 'Wrong password.';
    } else {
        session_regenerate_id(true);
        $_SESSION['signed_in'] = true;
        header('Location: ./');
        exit;
    }
}

$notice = '';
$action = (string) ($_POST['action'] ?? '');
// A held purchase (see stripe/index.php): released, a key is signed; refused, it stays without one
// and BlackArk refunds it in Stripe.
if (in_array($action, ['licence_release', 'licence_refuse'], true)) {
    if (empty($_SESSION['signed_in']) || !hash_equals($_SESSION['csrf'] ?? '', (string) ($_POST['csrf'] ?? ''))) {
        http_response_code(403);
        exit('Sign in again.');
    }
    $subscription = (string) ($_POST['subscription'] ?? '');
    $find = $db->prepare('SELECT held FROM licenses WHERE subscription_id = ?');
    $find->execute([$subscription]);
    if ((int) $find->fetchColumn() !== 1) {
        $error = 'No such held purchase.';
    } elseif ($action === 'licence_refuse') {
        $db->prepare("UPDATE licenses SET held = 3, status = 'refused', updated_at = ? WHERE subscription_id = ?")->execute([ark_now(), $subscription]);
        $notice = 'Refused. Refund it in Stripe.';
    } else {
        $db->prepare('UPDATE licenses SET held = 2, updated_at = ? WHERE subscription_id = ?')->execute([ark_now(), $subscription]);
        $read = $db->prepare('SELECT * FROM licenses WHERE subscription_id = ?');
        $read->execute([$subscription]);
        $row = $read->fetch();
        if ($row && $row['status'] === 'active' && $row['plan'] && $row['period_end']) {
            $addons = $row['addons'] ? explode(',', (string) $row['addons']) : [];
            $signed = ark_sign_license((string) $row['customer_id'], (string) $row['plan'], (int) $row['seats'], $addons, (int) $row['period_end'], $row['max_agents'] === null ? null : (int) $row['max_agents']);
            if ($signed) {
                $db->prepare('UPDATE licenses SET license_key = ?, valid_until = ?, updated_at = ? WHERE subscription_id = ?')
                    ->execute([$signed['key'], $signed['valid_until'], ark_now(), $subscription]);
            }
        }
        $notice = 'Released. The buyer\'s key page shows the key.';
    }
}
if (in_array($action, ['server_attach', 'server_stop'], true)) {
    if (empty($_SESSION['signed_in']) || !hash_equals($_SESSION['csrf'] ?? '', (string) ($_POST['csrf'] ?? ''))) {
        http_response_code(403);
        exit('Sign in again.');
    }
    ark_private_servers_table($db);
    $subscription = (string) ($_POST['subscription'] ?? '');
    $find = $db->prepare('SELECT status FROM private_servers WHERE subscription_id = ?');
    $find->execute([$subscription]);
    $current = $find->fetchColumn();
    if ($current === false) {
        $error = 'No such order.';
    } elseif ($action === 'server_stop') {
        $db->prepare("UPDATE private_servers SET status = 'stopped', updated_at = ? WHERE subscription_id = ?")->execute([time(), $subscription]);
        $notice = 'Marked stopped.';
    } else {
        $url = trim((string) ($_POST['base_url'] ?? ''));
        $model = trim((string) ($_POST['model'] ?? ''));
        $key = trim((string) ($_POST['api_key'] ?? ''));
        $parts = parse_url($url);
        if (
            !is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || !preg_match('#/v1/?$#', (string) ($parts['path'] ?? '')) || strlen($url) > 300
        ) {
            $error = 'The address must be https, with no name, password or query, and end in /v1.';
        } elseif ($model === '' || strlen($model) > 120 || preg_match('/[\x00-\x1f]/', $model)) {
            $error = 'Give the model name the server answers to.';
        } elseif (strlen($key) < 16 || strlen($key) > 512 || preg_match('/[^\x21-\x7e]/', $key)) {
            $error = 'The key must be 16 to 512 visible characters, with no spaces.';
        } else {
            $db->prepare("UPDATE private_servers SET status = 'ready', base_url = ?, model = ?, api_key = ?, ready_at = ?, updated_at = ? WHERE subscription_id = ?")
                ->execute([rtrim($url, '/'), $model, $key, time(), time(), $subscription]);
            $notice = 'Attached. The customer\'s app picks it up within a few minutes.';
        }
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
        // Only installs that proved who they are (v0.1.57): anybody can make up an unsigned check-in.
        if ($row['last_seen'] >= $recent && (int) $row['verified'] === 1) {
            $perCustomer[$row['customer_id']] = ($perCustomer[$row['customer_id']] ?? 0) + 1;
        }
    }
?>
  <header>
    <div>
      <h1>Trial check-ins</h1>
      <p class="note"><?= count($rows) ?> installs. Times are Athens time. Each install reports once a day; nothing about conversations is sent.</p>
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
        $second = (int) $row['verified'] === 1 && ($perCustomer[$row['customer_id']] ?? 0) > 1;
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
<?php
    $heldRows = $db->query('SELECT subscription_id, customer_id, stripe_customer, plan, seats, updated_at FROM licenses WHERE held = 1 ORDER BY updated_at DESC')->fetchAll();
?>
  <h2>Held purchases</h2>
  <p class="note">A purchase made through a buy link ArkAgent did not sign, or under a customer id another Stripe customer already pays for. No key is signed until you release it. Check with the customer who paid; refuse and refund it if it is not theirs.</p>
  <div class="wrap">
  <table>
    <thead><tr><th>Customer id</th><th>Bought by (Stripe)</th><th>Plan</th><th>Seats</th><th>When</th><th></th></tr></thead>
    <tbody>
    <?php if (!$heldRows): ?>
      <tr><td colspan="6" class="muted">None.</td></tr>
    <?php endif; ?>
    <?php foreach ($heldRows as $held): ?>
      <tr>
        <td class="flag"><?= h($held['customer_id']) ?></td>
        <td><?= h($held['stripe_customer']) ?></td>
        <td><?= h($held['plan']) ?></td>
        <td><?= (int) $held['seats'] ?></td>
        <td><?= athens((string) $held['updated_at']) ?></td>
        <td>
          <form method="post" action="./" class="attach">
            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
            <input type="hidden" name="subscription" value="<?= h($held['subscription_id']) ?>">
            <button type="submit" name="action" value="licence_release">Release</button>
            <button type="submit" name="action" value="licence_refuse">Refuse</button>
          </form>
        </td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
  </div>
<?php
    ark_selfserve_tables($db);
    $trials = $db->query('SELECT * FROM selfserve_trials ORDER BY issued_at DESC LIMIT 200')->fetchAll();
?>
  <h2>Self-serve trials</h2>
  <p class="note">Started from the app with a verified email (v0.1.58): 7 days of Ark Team 5, one per email, computer and company domain. The newest 200.</p>
  <div class="wrap">
  <table>
    <thead><tr><th>Customer id</th><th>Company</th><th>Name</th><th>Email</th><th>Started</th><th>Ends</th></tr></thead>
    <tbody>
    <?php if (!$trials): ?>
      <tr><td colspan="6" class="muted">None yet.</td></tr>
    <?php endif; ?>
    <?php foreach ($trials as $trialRow): ?>
      <tr>
        <td><?= h($trialRow['customer_id']) ?></td>
        <td><?= h($trialRow['company']) ?></td>
        <td><?= h($trialRow['name']) ?></td>
        <td><?= h($trialRow['email']) ?></td>
        <td><?= athens(gmdate('Y-m-d\TH:i:s\Z', (int) $trialRow['issued_at'])) ?></td>
        <td><?= athens(gmdate('Y-m-d\TH:i:s\Z', (int) $trialRow['until'])) ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
  </div>
<?php
    ark_private_servers_table($db);
    $orders = $db->query('SELECT * FROM private_servers ORDER BY ordered_at DESC')->fetchAll();
    $catalogue = ark_server_catalogue();
?>
  <h2>Ark Private Server orders</h2>
  <p class="note">Each paid order. Set the server up at the supplier, then attach it: its https address ending in /v1, the model it serves, and its key. The key is not shown again.</p>
  <?php if ($notice !== ''): ?><p class="ok" role="status"><?= h($notice) ?></p><?php endif; ?>
  <?php if ($error !== ''): ?><p class="error" role="alert"><?= h($error) ?></p><?php endif; ?>
  <div class="wrap">
  <table>
    <thead><tr><th>Customer</th><th>Tier</th><th>Status</th><th>Ordered</th><th>Paid until</th><th>Server</th><th></th></tr></thead>
    <tbody>
    <?php if (!$orders): ?>
      <tr><td colspan="7" class="muted">No order yet.</td></tr>
    <?php endif; ?>
    <?php foreach ($orders as $order): ?>
      <tr>
        <td><?= h($order['customer_id']) ?></td>
        <td><?= h($catalogue[$order['tier']]['name'] ?? $order['tier']) ?></td>
        <td<?= $order['status'] === 'setting_up' ? ' class="flag"' : '' ?>><?= h($order['status']) ?></td>
        <td><?= athens(gmdate('c', (int) $order['ordered_at'])) ?></td>
        <td><?= $order['paid_until'] ? athens(gmdate('c', (int) $order['paid_until'])) : '–' ?></td>
        <td><?= $order['base_url'] ? h($order['base_url']) . ' · ' . h($order['model']) . ' · key set' : '–' ?></td>
        <td>
          <?php if (in_array($order['status'], ['setting_up', 'ready', 'stopped'], true)): ?>
          <form method="post" action="./" class="attach">
            <input type="hidden" name="action" value="server_attach">
            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
            <input type="hidden" name="subscription" value="<?= h($order['subscription_id']) ?>">
            <input name="base_url" type="url" placeholder="https://…/v1" aria-label="Server address" required>
            <input name="model" placeholder="Model" aria-label="Model" required>
            <input name="api_key" type="password" placeholder="Key" aria-label="Key" autocomplete="off" required>
            <button type="submit">Attach</button>
          </form>
          <?php endif; ?>
          <?php if ($order['status'] === 'ready'): ?>
          <form method="post" action="./">
            <input type="hidden" name="action" value="server_stop">
            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
            <input type="hidden" name="subscription" value="<?= h($order['subscription_id']) ?>">
            <button type="submit">Mark stopped</button>
          </form>
          <?php endif; ?>
        </td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
  </div>
<?php endif; ?>
</main>
</body>
</html>
