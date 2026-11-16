<?php
/**
 * https://blackark.uk/checkin/skroutz/ — the Skroutz order inbox (#109, v0.1.43; Amgad 16 Nov, ok).
 *
 * WHY. Skroutz announces new and changed Smart Cart orders only by webhook, to a public https
 * address. A customer's ArkAgent sits behind their router and has none. So Skroutz posts here, and
 * that install collects what waited for it.
 *
 *   POST ?inbox=<id>                      from Skroutz: one order event, kept until collected.
 *   POST, Authorization: Bearer <secret>  from the install: every waiting event, then deleted.
 *
 * WHAT IS KEPT, AND FOR HOW LONG. The order event exactly as Skroutz sent it (it carries the buyer's
 * name and delivery address: the DPA says so), only until the install collects it, and never more
 * than 7 days: anything older is deleted on the next request. No IP address is stored. The inbox id
 * is random and is the webhook's only secret; the collect secret is stored as its SHA-256 only.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

ark_send_security_headers();
header('Cache-Control: no-store');
header('Content-Type: application/json; charset=utf-8');

const MAX_EVENT_BYTES = 262144;
const MAX_WAITING = 1000;
const KEEP_DAYS = 7;

function answer(int $status, array $body = []): void
{
    http_response_code($status);
    echo json_encode($body ?: new stdClass(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    answer(405, ['error' => 'POST only.']);
}

$db = ark_db();
$db->prepare('DELETE FROM skroutz_events WHERE received_at < ?')
    ->execute([gmdate('Y-m-d\TH:i:s\Z', time() - KEEP_DAYS * 86400)]);

$auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
if (preg_match('/^Bearer\s+([A-Za-z0-9_-]{20,200})$/', $auth, $match) === 1) {
    // The install, collecting.
    $find = $db->prepare('SELECT inbox_id FROM skroutz_inboxes WHERE secret_sha256 = ?');
    $find->execute([hash('sha256', $match[1])]);
    $inbox = $find->fetchColumn();
    if ($inbox === false) {
        sleep(1);
        answer(403, ['error' => 'Unknown inbox key.']);
    }
    $db->beginTransaction();
    $read = $db->prepare('SELECT id, body FROM skroutz_events WHERE inbox_id = ? ORDER BY id LIMIT 200');
    $read->execute([$inbox]);
    $events = [];
    $last = 0;
    foreach ($read->fetchAll() as $row) {
        $decoded = json_decode((string) $row['body'], true);
        if (is_array($decoded)) {
            $events[] = $decoded;
        }
        $last = (int) $row['id'];
    }
    if ($last > 0) {
        $db->prepare('DELETE FROM skroutz_events WHERE inbox_id = ? AND id <= ?')->execute([$inbox, $last]);
    }
    $db->prepare('UPDATE skroutz_inboxes SET last_collect_at = ? WHERE inbox_id = ?')->execute([ark_now(), $inbox]);
    $db->commit();
    answer(200, ['events' => $events]);
}

// Skroutz, delivering.
$inbox = (string) ($_GET['inbox'] ?? '');
if (preg_match('/^[A-Za-z0-9_-]{20,64}$/', $inbox) !== 1) {
    answer(404, ['error' => 'No such inbox.']);
}
$known = $db->prepare('SELECT 1 FROM skroutz_inboxes WHERE inbox_id = ?');
$known->execute([$inbox]);
if ($known->fetchColumn() === false) {
    answer(404, ['error' => 'No such inbox.']);
}
$length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($length > MAX_EVENT_BYTES) {
    answer(413, ['error' => 'Too large.']);
}
$raw = (string) file_get_contents('php://input', false, null, 0, MAX_EVENT_BYTES + 1);
if (strlen($raw) > MAX_EVENT_BYTES) {
    answer(413, ['error' => 'Too large.']);
}
$event = json_decode($raw, true);
if (!is_array($event) || !is_array($event['order'] ?? null)) {
    answer(400, ['error' => 'Not a Skroutz order event.']);
}
$count = $db->prepare('SELECT COUNT(*) FROM skroutz_events WHERE inbox_id = ?');
$count->execute([$inbox]);
if ((int) $count->fetchColumn() >= MAX_WAITING) {
    answer(429, ['error' => 'The inbox is full; the install has not collected it.']);
}
$db->prepare('INSERT INTO skroutz_events (inbox_id, received_at, body) VALUES (?, ?, ?)')
    ->execute([$inbox, ark_now(), json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
$db->prepare('UPDATE skroutz_inboxes SET last_event_at = ? WHERE inbox_id = ?')->execute([ark_now(), $inbox]);
answer(200, ['ok' => true]);
