<?php
/**
 * https://blackark.uk/checkin/audit-copy/ — the off-site copy of the Control Board's audit log (#149).
 *
 * Only the board calls this, once a night (`AUDIT_COPY=blackark`). It keeps the entries the board
 * sends, append-only: nothing here changes or removes one, and the table's triggers refuse both.
 * It is the copy to compare against if the board's own log is ever in doubt.
 *
 * THE REQUEST. POST, a JSON body of at most 2 MB, signed as the export's requests are:
 *   X-Ark-Time       the Unix time, within 5 minutes of this server's clock;
 *   X-Ark-Nonce      16 to 64 characters of [A-Za-z0-9_-], new for every request (taken once);
 *   X-Ark-Signature  the hex HMAC-SHA256 of "<time>.<nonce>.<body>" with `audit_copy_secret`.
 * The body is {"prevHash": <hex>, "entries": [<row>, …]}: at most 2,000 rows, oldest first, each
 * {id, at, actor, role, action, target, outcome, detail, prev_hash, hash}.
 *
 * WHAT IS TAKEN. Only a batch that continues the copy:
 *   - `prevHash` is the hash of an entry kept here (or 64 zeros for the first batch);
 *   - the ids follow on from it with no gap, each `prev_hash` is the hash before it, and each `hash`
 *     is SHA-256 of "<prev_hash>\n<JSON of [id, at, actor, role, action, target, outcome, detail]>",
 *     recomputed here;
 *   - an entry kept here already must come again exactly the same (the board resending a batch whose
 *     answer it lost); a different one is refused (409): the copy is never rewritten.
 *
 * THE ANSWER. {"stored": <new entries>, "lastId": <the last id kept>}, signed back like the export's
 * (X-Ark-Time, and X-Ark-Signature over "<time>.<the request's nonce>.<answer>").
 *
 * What the entries hold: staff user names, roles, actions and the customer ids they were about. No
 * customer's name, email or words.
 */

declare(strict_types=1);
define('ARK_CHECKIN', true);
require dirname(__DIR__) . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

const AUDIT_COPY_MAX_BODY = 2097152;
const AUDIT_COPY_MAX_ENTRIES = 2000;
const AUDIT_COPY_GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';

function audit_copy_refuse(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

/** The same bytes as the board's JSON.stringify of the hashed fields. */
function audit_copy_hash(string $prev, array $row): string
{
    $fields = [$row['id'], $row['at'], $row['actor'], $row['role'], $row['action'], $row['target'], $row['outcome'], $row['detail']];
    $json = json_encode($fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS);
    return hash('sha256', $prev . "\n" . $json);
}

/** A row as the board sends it, or null. */
function audit_copy_row($row): ?array
{
    if (!is_array($row)) {
        return null;
    }
    $text = fn($v, int $max) => is_string($v) && strlen($v) <= $max;
    $textOrNull = fn($v, int $max) => $v === null || $text($v, $max);
    $hex = fn($v) => is_string($v) && preg_match('/^[0-9a-f]{64}$/', $v) === 1;
    if (
        !is_int($row['id'] ?? null) || $row['id'] < 1 ||
        !$text($row['at'] ?? null, 40) ||
        !$textOrNull($row['actor'] ?? null, 200) ||
        !$textOrNull($row['role'] ?? null, 40) ||
        !$text($row['action'] ?? null, 200) ||
        !$textOrNull($row['target'] ?? null, 400) ||
        !in_array($row['outcome'] ?? null, ['ok', 'refused'], true) ||
        !$textOrNull($row['detail'] ?? null, 2000) ||
        !$hex($row['prev_hash'] ?? null) ||
        !$hex($row['hash'] ?? null)
    ) {
        return null;
    }
    return $row;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    audit_copy_refuse(405, 'POST only.');
}
$secret = (string) ark_config('audit_copy_secret', '');
if (strlen($secret) < 32) {
    audit_copy_refuse(503, 'Not configured.');
}
$body = (string) file_get_contents('php://input', false, null, 0, AUDIT_COPY_MAX_BODY + 1);
if (strlen($body) > AUDIT_COPY_MAX_BODY) {
    audit_copy_refuse(413, 'Too large.');
}
$time = (string) ($_SERVER['HTTP_X_ARK_TIME'] ?? '');
$nonce = (string) ($_SERVER['HTTP_X_ARK_NONCE'] ?? '');
$signature = (string) ($_SERVER['HTTP_X_ARK_SIGNATURE'] ?? '');
if (
    preg_match('/^\d{1,12}$/', $time) !== 1 ||
    preg_match('/^[A-Za-z0-9_-]{16,64}$/', $nonce) !== 1 ||
    !hash_equals(hash_hmac('sha256', $time . '.' . $nonce . '.' . $body, $secret), $signature)
) {
    audit_copy_refuse(403, 'Bad signature.');
}
if (abs(time() - (int) $time) > 300) {
    audit_copy_refuse(403, 'Stale request.');
}
$batch = json_decode($body, true);
$prevHash = is_array($batch) ? ($batch['prevHash'] ?? null) : null;
$entries = is_array($batch) ? ($batch['entries'] ?? null) : null;
if (
    !is_string($prevHash) || preg_match('/^[0-9a-f]{64}$/', $prevHash) !== 1 ||
    !is_array($entries) || $entries !== array_values($entries) || count($entries) > AUDIT_COPY_MAX_ENTRIES
) {
    audit_copy_refuse(400, 'Not an audit batch.');
}

$db = ark_db();
$db->exec('CREATE TABLE IF NOT EXISTS audit_copy_nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)');
$db->exec('CREATE TABLE IF NOT EXISTS audit_copy (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT,
    role TEXT,
    action TEXT NOT NULL,
    target TEXT,
    outcome TEXT NOT NULL,
    detail TEXT,
    prev_hash TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL UNIQUE,
    received_at TEXT NOT NULL
)');
$db->exec("CREATE TRIGGER IF NOT EXISTS audit_copy_no_update BEFORE UPDATE ON audit_copy
    BEGIN SELECT RAISE(ABORT, 'the audit copy is append-only'); END");
$db->exec("CREATE TRIGGER IF NOT EXISTS audit_copy_no_delete BEFORE DELETE ON audit_copy
    BEGIN SELECT RAISE(ABORT, 'the audit copy is append-only'); END");

$db->prepare('DELETE FROM audit_copy_nonces WHERE at < ?')->execute([time() - 900]);
$take = $db->prepare('INSERT OR IGNORE INTO audit_copy_nonces (nonce, at) VALUES (?, ?)');
$take->execute([$nonce, time()]);
if ($take->rowCount() === 0) {
    audit_copy_refuse(409, 'Already used.');
}

// One writer at a time, so two batches cannot both continue from the same entry.
$db->exec('BEGIN IMMEDIATE');
try {
    if ($prevHash === AUDIT_COPY_GENESIS) {
        $nextId = 1;
    } else {
        $from = $db->prepare('SELECT id FROM audit_copy WHERE hash = ?');
        $from->execute([$prevHash]);
        $fromId = $from->fetchColumn();
        if ($fromId === false) {
            throw new DomainException('The batch does not continue the copy.');
        }
        $nextId = (int) $fromId + 1;
    }
    $kept = $db->prepare('SELECT hash FROM audit_copy WHERE id = ?');
    $insert = $db->prepare('INSERT INTO audit_copy (id, at, actor, role, action, target, outcome, detail, prev_hash, hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $prev = $prevHash;
    $stored = 0;
    foreach ($entries as $raw) {
        $row = audit_copy_row($raw);
        if ($row === null || $row['id'] !== $nextId || $row['prev_hash'] !== $prev || audit_copy_hash($prev, $row) !== $row['hash']) {
            throw new DomainException('Entry ' . ($row['id'] ?? '?') . ' does not follow from the one before.');
        }
        $kept->execute([$row['id']]);
        $already = $kept->fetchColumn();
        if ($already !== false) {
            if ($already !== $row['hash']) {
                throw new DomainException('Entry ' . $row['id'] . ' is kept already, differently: the copy is not rewritten.');
            }
        } else {
            $insert->execute([$row['id'], $row['at'], $row['actor'], $row['role'], $row['action'], $row['target'], $row['outcome'], $row['detail'], $row['prev_hash'], $row['hash'], ark_now()]);
            $stored += 1;
        }
        $prev = $row['hash'];
        $nextId += 1;
    }
    $db->exec('COMMIT');
} catch (DomainException $refused) {
    $db->exec('ROLLBACK');
    audit_copy_refuse(409, $refused->getMessage());
} catch (Throwable $failed) {
    $db->exec('ROLLBACK');
    audit_copy_refuse(500, 'Not stored.');
}

$lastId = $nextId > 1 ? $nextId - 1 : $db->query('SELECT MAX(id) FROM audit_copy')->fetchColumn();
$answer = json_encode(['stored' => $stored, 'lastId' => $lastId === null || $lastId === false ? null : (int) $lastId]);
$answeredAt = (string) time();
header('X-Ark-Time: ' . $answeredAt);
header('X-Ark-Signature: ' . hash_hmac('sha256', $answeredAt . '.' . $nonce . '.' . $answer, $secret));
echo $answer;
