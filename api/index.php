<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function json_in(): array {
  $raw = file_get_contents('php://input');
  if (!$raw) return [];
  $data = json_decode($raw, true);
  return is_array($data) ? $data : [];
}

function ok($data): void {
  http_response_code(200);
  echo json_encode($data, JSON_UNESCAPED_SLASHES);
  exit;
}

function err(string $msg, int $code = 400): void {
  http_response_code($code);
  echo json_encode(['error' => $msg], JSON_UNESCAPED_SLASHES);
  exit;
}

function send_csv($filename, $rows) {
  header('Content-Type: text/csv; charset=utf-8');
  header('Content-Disposition: attachment; filename="'.$filename.'"');
  $out = fopen('php://output', 'w');

  foreach ($rows as $r) fputcsv($out, $r);
  fclose($out);
  exit;
}

function path_no_api_prefix(string $path): string {
  // if served via /public/api/index.php, REQUEST_URI includes /api/...
  if (str_starts_with($path, '/api')) return substr($path, 4) ?: '/';
  return $path ?: '/';
}

$dbPath = __DIR__ . '/data.sqlite';
$db = new PDO('sqlite:' . $dbPath);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

// --- Init tables ---
$db->exec("
    CREATE TABLE IF NOT EXISTS months (
    month_key TEXT PRIMARY KEY
    );
");

$db->exec("
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      color TEXT NOT NULL
    );
");

$db->exec("
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_key TEXT NOT NULL,
      category_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    tdate TEXT NOT NULL,
      note TEXT,
    FOREIGN KEY(month_key) REFERENCES months(month_key),
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );
");

$db->exec("
  CREATE TABLE IF NOT EXISTS goals (
    month_key TEXT PRIMARY KEY,
    savings_goal INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(month_key) REFERENCES months(month_key)
  );
");

$db->exec("
  CREATE TABLE IF NOT EXISTS budgets (
    month_key TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    budget_amount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month_key, category_id),
    FOREIGN KEY(month_key) REFERENCES months(month_key),
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );
");

$db->exec("
  CREATE TABLE IF NOT EXISTS recurring_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    day_of_month INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    variable INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );
  ");

// Add 'variable' column if upgrading an existing database
try {
  $db->exec("ALTER TABLE recurring_templates ADD COLUMN variable INTEGER NOT NULL DEFAULT 0");
} catch (Throwable $e) { /* column already exists */ }

$db->exec("
  CREATE TABLE IF NOT EXISTS recurring_runs (
    month_key TEXT NOT NULL,
    template_id INTEGER NOT NULL,
    PRIMARY KEY (month_key, template_id),
    FOREIGN KEY(month_key) REFERENCES months(month_key),
    FOREIGN KEY(template_id) REFERENCES recurring_templates(id)
  );
");

// Seed default categories once (optional)
$hasCats = (int)$db->query("SELECT COUNT(*) FROM categories")->fetchColumn();
if ($hasCats === 0) {
    $seed = [
      ['Salary','income','#08F850'],
      ['Side Gigs','income','#58D8B0'],
      ['Groceries','expense','#E82888'],
      ['Transport','expense','#7028F8'],
    ['Bills','expense','#F0A810'],
  ];
  $st = $db->prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)");
  foreach ($seed as $c) $st->execute($c);
}

// --- Routing ---
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$reqPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = path_no_api_prefix($reqPath);

// Normalize
$path = rtrim($path, '/') ?: '/';

if ($path === '/months' && $method === 'GET') {
  $rows = $db->query("SELECT month_key FROM months ORDER BY month_key DESC")->fetchAll(PDO::FETCH_COLUMN);
  ok(['months' => $rows]);
}

if ($path === '/months' && $method === 'POST') {
  $b = json_in();
  $mk = trim((string)($b['month_key'] ?? ''));
  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month_key must be YYYY-MM');

  $st = $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)");
  $st->execute([$mk]);

  // Ensure goal row exists
  $st2 = $db->prepare("INSERT OR IGNORE INTO goals(month_key, savings_goal) VALUES(?, 0)");
  $st2->execute([$mk]);

  ok(['ok' => true]);
}

if ($path === '/categories' && $method === 'GET') {
  $rows = $db->query("SELECT id,name,type,color FROM categories ORDER BY type ASC, name ASC")->fetchAll(PDO::FETCH_ASSOC);
  ok(['categories' => $rows]);
}

if ($path === '/categories' && $method === 'POST') {
  $b = json_in();
    $name = trim((string)($b['name'] ?? ''));
    $type = (string)($b['type'] ?? '');
  $color = (string)($b['color'] ?? '');

  if ($name === '') err('Category name required');
  if (!in_array($type, ['income','expense'], true)) err('type must be income or expense');
  if ($color === '') err('color required');

  $st = $db->prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)");
  $st->execute([$name,$type,$color]);

  ok(['ok' => true, 'id' => (int)$db->lastInsertId()]);
}

if (preg_match('#^/categories/(\d+)$#', $path, $m) && $method === 'DELETE') {
  $id = (int)$m[1];

  $st = $db->prepare("SELECT COUNT(*) FROM transactions WHERE category_id=?");
  $st->execute([$id]);
  $cnt = (int)$st->fetchColumn();
  if ($cnt > 0) err('Cannot delete category with transactions', 409);

  $st2 = $db->prepare("DELETE FROM categories WHERE id=?");
  $st2->execute([$id]);

  ok(['ok' => true]);
}

if ($path === '/transactions' && $method === 'GET') {
  $mk = trim((string)($_GET['month'] ?? ''));
  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month query param required (YYYY-MM)');

  $st = $db->prepare("
    SELECT
      t.id,
      t.category_id AS category_id,
      t.amount,
      t.tdate,
      COALESCE(t.note,'') AS note,
      c.name AS category_name,
      c.type AS category_type,
      c.color AS category_color
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
    WHERE t.month_key = ?
      ORDER BY t.tdate DESC, t.id DESC
    ");
  $st->execute([$mk]);
  $rows = $st->fetchAll(PDO::FETCH_ASSOC);

  ok(['transactions' => $rows]);
}

if ($path === '/transactions' && $method === 'POST') {
  $b = json_in();
  $mk = trim((string)($b['month_key'] ?? ''));
  $catId = (int)($b['category_id'] ?? 0);
  $amount = (int)($b['amount'] ?? 0);
  $date = trim((string)($b['date'] ?? ''));
    $note = (string)($b['note'] ?? '');

  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month_key must be YYYY-MM');
  if ($catId <= 0) err('category_id required');
  if ($amount <= 0) err('amount must be > 0');
  if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) err('date must be YYYY-MM-DD');

  $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$mk]);
  $db->prepare("INSERT OR IGNORE INTO goals(month_key, savings_goal) VALUES(?,0)")->execute([$mk]);

  $st = $db->prepare("INSERT INTO transactions(month_key,category_id,amount,tdate,note) VALUES(?,?,?,?,?)");
  $st->execute([$mk,$catId,$amount,$date,$note]);

  ok(['ok' => true, 'id' => (int)$db->lastInsertId()]);
}

// PUT /api/transactions/{id}
if (preg_match('#^/transactions/(\d+)$#', $path, $m) && $method === 'PUT') {
  $id = (int)$m[1];
  $b = json_in();

  $catId = (int)($b['category_id'] ?? 0);
  $amt   = (int)($b['amount'] ?? 0);
  $tdate = trim((string)($b['tdate'] ?? ''));
  $note  = (string)($b['note'] ?? '');

  if ($catId <= 0) err('category_id required');
  if ($amt <= 0) err('amount must be > 0');
  if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $tdate)) err('tdate must be YYYY-MM-DD');

  // find transaction month_key (we keep edits inside the same month)
  $st = $db->prepare("SELECT month_key FROM transactions WHERE id=?");
  $st->execute([$id]);
  $mk = $st->fetchColumn();
  if (!$mk) err('Transaction not found', 404);

  if (substr($tdate, 0, 7) !== $mk) err('Date must stay within the same month', 409);

  $st2 = $db->prepare("UPDATE transactions SET category_id=?, amount=?, tdate=?, note=? WHERE id=?");
  $st2->execute([$catId, $amt, $tdate, $note, $id]);

  ok(['ok' => true]);
}

if (preg_match('#^/transactions/(\d+)$#', $path, $m) && $method === 'DELETE') {
  $id = (int)$m[1];
  $st = $db->prepare("DELETE FROM transactions WHERE id=?");
  $st->execute([$id]);
  ok(['ok' => true]);
}

/**
 * NEW: Save goal
 * POST /api/goal  { month_key: "YYYY-MM", savings_goal: 100000 }
 */
if ($path === '/goal' && $method === 'POST') {
  $b = json_in();
  $mk = trim((string)($b['month_key'] ?? ''));
  $goal = (int)($b['savings_goal'] ?? 0);

  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month_key must be YYYY-MM');
  if ($goal < 0) err('savings_goal must be >= 0');

  $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$mk]);
  $st = $db->prepare("INSERT INTO goals(month_key, savings_goal) VALUES(?, ?) 
                      ON CONFLICT(month_key) DO UPDATE SET savings_goal=excluded.savings_goal");
  $st->execute([$mk, $goal]);

  ok(['ok' => true]);
}

if ($path === '/summary' && $method === 'GET') {
  $mk = trim((string)($_GET['month'] ?? ''));
  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month query param required (YYYY-MM)');

  // totals
  $stIn = $db->prepare("
    SELECT COALESCE(SUM(t.amount),0)
    FROM transactions t
    JOIN categories c ON c.id=t.category_id
    WHERE t.month_key=? AND c.type='income'
  ");
  $stIn->execute([$mk]);
  $income = (int)$stIn->fetchColumn();

  $stOut = $db->prepare("
    SELECT COALESCE(SUM(t.amount),0)
    FROM transactions t
    JOIN categories c ON c.id=t.category_id
    WHERE t.month_key=? AND c.type='expense'
  ");
  $stOut->execute([$mk]);
  $expenses = (int)$stOut->fetchColumn();

  $balance = $income - $expenses;

  // breakdown
  $stB = $db->prepare("
    SELECT c.name, c.type, c.color, COALESCE(SUM(t.amount),0) AS amount
    FROM categories c
    LEFT JOIN transactions t ON t.category_id=c.id AND t.month_key=?
    GROUP BY c.id
    HAVING amount > 0
    ORDER BY amount DESC
  ");
  $stB->execute([$mk]);
  $breakdown = $stB->fetchAll(PDO::FETCH_ASSOC);

  // highest spend (expense max)
  $stTop = $db->prepare("
    SELECT c.name, COALESCE(SUM(t.amount),0) AS amount
    FROM transactions t
    JOIN categories c ON c.id=t.category_id
    WHERE t.month_key=? AND c.type='expense'
    GROUP BY c.id
    ORDER BY amount DESC
    LIMIT 1
  ");
  $stTop->execute([$mk]);
  $topRow = $stTop->fetch(PDO::FETCH_ASSOC);
  $highest = $topRow ? ['name' => $topRow['name'], 'amount' => (int)$topRow['amount']] : null;

  // top 3 expense categories
  $stTop3 = $db->prepare("
    SELECT c.name, c.color, COALESCE(SUM(t.amount),0) AS amount
    FROM transactions t
    JOIN categories c ON c.id=t.category_id
    WHERE t.month_key=? AND c.type='expense'
    GROUP BY c.id
    ORDER BY amount DESC
    LIMIT 3
  ");
  $stTop3->execute([$mk]);
  $top3 = $stTop3->fetchAll(PDO::FETCH_ASSOC);

  // goal
  $stG = $db->prepare("SELECT savings_goal FROM goals WHERE month_key=?");
  $stG->execute([$mk]);
  $goal = (int)($stG->fetchColumn() ?? 0);

  $progress = 0.0;
  if ($goal > 0 && $balance > 0) {
    $progress = min(1.0, $balance / $goal);
  }

  $diff = $balance - $goal; // >=0 means over goal
  $overspend = $expenses > $income;
  $overspendAmount = $overspend ? ($expenses - $income) : 0;

  ok([
    'total_income' => $income,
    'total_expenses' => $expenses,
    'balance' => $balance,
    'highest_spend' => $highest,
    'breakdown' => $breakdown,
    'top_expenses' => array_map(fn($r) => [
        'name' => $r['name'],
        'color' => $r['color'],
      'amount' => (int)$r['amount'],
    ], $top3),

    // NEW goal fields
    'savings_goal' => $goal,
    'savings_progress' => $progress,   // 0..1
    'savings_diff' => $diff,           // balance - goal
    'overspend' => $overspend,
    'overspend_amount' => $overspendAmount
  ]);
}

// GET /api/budgets?month=YYYY-MM
if ($path === '/budgets' && $method === 'GET') {
  $mk = trim((string)($_GET['month'] ?? ''));
  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month query param required (YYYY-MM)');

  $st = $db->prepare("
    SELECT category_id, budget_amount
    FROM budgets
    WHERE month_key = ?
    ORDER BY category_id ASC
  ");
  $st->execute([$mk]);
  $rows = $st->fetchAll(PDO::FETCH_ASSOC);

  ok(['budgets' => array_map(fn($r) => [
    'category_id' => (int)$r['category_id'],
    'budget_amount' => (int)$r['budget_amount'],
  ], $rows)]);
}

// POST /api/budgets  { month_key: "YYYY-MM", category_id: 1, budget_amount: 5000 }
if ($path === '/budgets' && $method === 'POST') {
  $b = json_in();
  $mk = trim((string)($b['month_key'] ?? ''));
  $catId = (int)($b['category_id'] ?? 0);
  $amt = (int)($b['budget_amount'] ?? -1);

  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month_key must be YYYY-MM');
  if ($catId <= 0) err('category_id required');
  if ($amt < 0) err('budget_amount must be >= 0');

  // Ensure month exists
  $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$mk]);

  // Ensure category exists AND is expense-only
  $stC = $db->prepare("SELECT type FROM categories WHERE id=?");
  $stC->execute([$catId]);
  $type = $stC->fetchColumn();
  if (!$type) err('Category not found', 404);
  if ($type !== 'expense') err('Budgets can only be set for expense categories', 409);

  // Upsert
  $st = $db->prepare("
    INSERT INTO budgets(month_key, category_id, budget_amount)
    VALUES(?, ?, ?)
    ON CONFLICT(month_key, category_id) DO UPDATE SET budget_amount=excluded.budget_amount
  ");
  $st->execute([$mk, $catId, $amt]);

  ok(['ok' => true]);
}

// DELETE /api/budgets?month=YYYY-MM&category_id=1
if ($path === '/budgets' && $method === 'DELETE') {
  $mk = trim((string)($_GET['month'] ?? ''));
  $catId = (int)($_GET['category_id'] ?? 0);

  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month query param required (YYYY-MM)');
  if ($catId <= 0) err('category_id required');

  $st = $db->prepare("DELETE FROM budgets WHERE month_key=? AND category_id=?");
  $st->execute([$mk, $catId]);

  ok(['ok' => true]);
}

// POST /api/budgets/copy  { from_month: "YYYY-MM", to_month: "YYYY-MM" }
if ($path === '/budgets/copy' && $method === 'POST') {
  $b = json_in();
  $from = trim((string)($b['from_month'] ?? ''));
  $to = trim((string)($b['to_month'] ?? ''));

  if (!preg_match('/^\d{4}-\d{2}$/', $from)) err('from_month must be YYYY-MM');
  if (!preg_match('/^\d{4}-\d{2}$/', $to)) err('to_month must be YYYY-MM');
  if ($from === $to) err('from_month and to_month must be different');

  // ensure destination month exists
  $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$to]);

  // Copy budgets (upsert)
  $st = $db->prepare("
    INSERT INTO budgets(month_key, category_id, budget_amount)
    SELECT ?, category_id, budget_amount
    FROM budgets
    WHERE month_key = ?
    ON CONFLICT(month_key, category_id) DO UPDATE SET budget_amount=excluded.budget_amount
  ");
  $st->execute([$to, $from]);

  ok(['ok' => true]);
}

// GET /api/recurring
if ($path === '/recurring' && $method === 'GET') {
  $rows = $db->query("
    SELECT
      r.id, r.category_id, r.amount, r.day_of_month, COALESCE(r.note,'') AS note, r.enabled, r.variable,
      c.name AS category_name, c.type AS category_type, c.color AS category_color
    FROM recurring_templates r
    JOIN categories c ON c.id = r.category_id
    ORDER BY r.enabled DESC, c.type ASC, c.name ASC
  ")->fetchAll(PDO::FETCH_ASSOC);

  ok(['recurring' => array_map(fn($r) => [
    'id' => (int)$r['id'],
    'category_id' => (int)$r['category_id'],
    'amount' => (int)$r['amount'],
    'day_of_month' => (int)$r['day_of_month'],
    'note' => $r['note'],
    'enabled' => (int)$r['enabled'],
    'variable' => (int)$r['variable'],
    'category_name' => $r['category_name'],
    'category_type' => $r['category_type'],
    'category_color' => $r['category_color'],
  ], $rows)]);
}

// POST /api/recurring  { category_id, amount, day_of_month, note, enabled }
if ($path === '/recurring' && $method === 'POST') {
  $b = json_in();
  $catId = (int)($b['category_id'] ?? 0);
  $amount = (int)($b['amount'] ?? 0);
  $day = (int)($b['day_of_month'] ?? 1);
  $note = (string)($b['note'] ?? '');
  $enabled = (int)($b['enabled'] ?? 1);
  $variable = (int)($b['variable'] ?? 0);
  $variable = $variable ? 1 : 0;

  if ($catId <= 0) err('category_id required');
  if ($variable === 0 && $amount <= 0) err('amount must be > 0 for fixed templates');
  if ($variable === 1 && $amount < 0) err('amount must be >= 0');
  if ($day < 1 || $day > 31) err('day_of_month must be 1..31');
  $enabled = $enabled ? 1 : 0;

  $stC = $db->prepare("SELECT id FROM categories WHERE id=?");
  $stC->execute([$catId]);
  if (!$stC->fetchColumn()) err('Category not found', 404);

  $st = $db->prepare("INSERT INTO recurring_templates(category_id,amount,day_of_month,note,enabled,variable) VALUES(?,?,?,?,?,?)");
  $st->execute([$catId,$amount,$day,$note,$enabled,$variable]);

  ok(['ok' => true, 'id' => (int)$db->lastInsertId()]);
}

// PUT /api/recurring/{id}
if (preg_match('#^/recurring/(\d+)$#', $path, $m) && $method === 'PUT') {
  $id = (int)$m[1];
  $b = json_in();

  $amount = isset($b['amount']) ? (int)$b['amount'] : null;
  $day = isset($b['day_of_month']) ? (int)$b['day_of_month'] : null;
  $note = array_key_exists('note', $b) ? (string)$b['note'] : null;
  $enabled = isset($b['enabled']) ? ((int)$b['enabled'] ? 1 : 0) : null;
  $variable = isset($b['variable']) ? ((int)$b['variable'] ? 1 : 0) : null;

  $st = $db->prepare("SELECT id FROM recurring_templates WHERE id=?");
  $st->execute([$id]);
  if (!$st->fetchColumn()) err('Recurring template not found', 404);

  if ($amount !== null && $amount <= 0) err('amount must be > 0');
  if ($day !== null && ($day < 1 || $day > 31)) err('day_of_month must be 1..31');

  $fields = [];
  $vals = [];
  if ($amount !== null) { $fields[] = "amount=?"; $vals[] = $amount; }
  if ($day !== null) { $fields[] = "day_of_month=?"; $vals[] = $day; }
  if ($note !== null) { $fields[] = "note=?"; $vals[] = $note; }
  if ($enabled !== null) { $fields[] = "enabled=?"; $vals[] = $enabled; }
  if ($variable !== null) { $fields[] = "variable=?"; $vals[] = $variable; }

  if (!$fields) ok(['ok' => true]); // nothing to update

  $vals[] = $id;
  $sql = "UPDATE recurring_templates SET " . implode(", ", $fields) . " WHERE id=?";
  $db->prepare($sql)->execute($vals);

  ok(['ok' => true]);
}

// DELETE /api/recurring/{id}
if (preg_match('#^/recurring/(\d+)$#', $path, $m) && $method === 'DELETE') {
  $id = (int)$m[1];
  $db->prepare("DELETE FROM recurring_templates WHERE id=?")->execute([$id]);
  ok(['ok' => true]);
}

// POST /api/recurring/apply  { month_key: "YYYY-MM", overrides: { "12": 5000, "13": 12000 } }
if ($path === '/recurring/apply' && $method === 'POST') {
  $b = json_in();
  $mk = trim((string)($b['month_key'] ?? ''));
  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month_key must be YYYY-MM');

  $overrides = $b['overrides'] ?? [];
  if (!is_array($overrides)) $overrides = [];

  $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$mk]);
  $db->prepare("INSERT OR IGNORE INTO goals(month_key, savings_goal) VALUES(?,0)")->execute([$mk]);

  $templates = $db->query("
    SELECT id, category_id, amount, day_of_month, COALESCE(note,'') AS note, variable
    FROM recurring_templates
    WHERE enabled=1
  ")->fetchAll(PDO::FETCH_ASSOC);

  $dt = DateTime::createFromFormat('Y-m-d', $mk . '-01');
  $lastDay = (int)$dt->format('t');

  $stRun = $db->prepare("INSERT OR IGNORE INTO recurring_runs(month_key, template_id) VALUES(?,?)");
  $stTx  = $db->prepare("INSERT INTO transactions(month_key,category_id,amount,tdate,note) VALUES(?,?,?,?,?)");

  $added = 0;
  foreach ($templates as $t) {
    $tid = (int)$t['id'];
    $baseAmt = (int)$t['amount'];
    $isVar = (int)$t['variable'] === 1;

    $overrideAmt = null;
    if (array_key_exists((string)$tid, $overrides)) $overrideAmt = (int)$overrides[(string)$tid];
    if (array_key_exists($tid, $overrides)) $overrideAmt = (int)$overrides[$tid];

    $useAmt = ($overrideAmt !== null) ? $overrideAmt : $baseAmt;

    // Variable templates REQUIRE an override (>0). Fixed templates can use base amount.
    if ($isVar && $useAmt <= 0) continue;
    if (!$isVar && $useAmt <= 0) continue;

    $day = max(1, min($lastDay, (int)$t['day_of_month']));
    $date = sprintf('%s-%02d', $mk, $day);

    $stRun->execute([$mk, $tid]);
    $changed = (int)$db->query("SELECT changes()")->fetchColumn();
    if ($changed > 0) {
      $note = $t['note'] !== '' ? $t['note'] : 'Recurring';
      $stTx->execute([$mk, (int)$t['category_id'], $useAmt, $date, $note]);
      $added++;
    }
  }

  ok(['ok' => true, 'added' => $added]);
}

// GET /api/month/export?month=YYYY-MM&format=json|csv
if ($path === '/month/export' && $method === 'GET') {
  $mk = trim((string)($_GET['month'] ?? ''));
  $format = strtolower(trim((string)($_GET['format'] ?? 'json')));

  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month query param required (YYYY-MM)');
  if (!in_array($format, ['json','csv'])) err('format must be json or csv');

  // Transactions with category details
  $stTx = $db->prepare("
    SELECT
      t.amount, t.tdate, COALESCE(t.note,'') AS note,
      c.name AS category_name, c.type AS category_type, c.color AS category_color
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.month_key = ?
    ORDER BY t.tdate ASC, t.id ASC
  ");
  $stTx->execute([$mk]);
  $txs = $stTx->fetchAll(PDO::FETCH_ASSOC);

  if ($format === 'csv') {
    $rows = [];
    $rows[] = ['date','type','category','amount','note'];
    foreach ($txs as $t) {
      $rows[] = [$t['tdate'], $t['category_type'], $t['category_name'], (int)$t['amount'], $t['note']];
    }
    send_csv("money-tracker-$mk.csv", $rows);
  }

  // Goal
  $stG = $db->prepare("SELECT COALESCE(savings_goal,0) AS savings_goal FROM goals WHERE month_key=?");
  $stG->execute([$mk]);
  $goal = $stG->fetch(PDO::FETCH_ASSOC);
  $goalVal = $goal ? (int)$goal['savings_goal'] : 0;

  // Budgets (with category)
  $stB = $db->prepare("
    SELECT b.budget_amount, c.name AS category_name, c.type AS category_type, c.color AS category_color
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    WHERE b.month_key = ?
    ORDER BY c.name ASC
  ");
  $stB->execute([$mk]);
  $budgets = $stB->fetchAll(PDO::FETCH_ASSOC);

  // Categories referenced (from txs + budgets)
  $catSet = [];
  foreach ($txs as $t) {
    $key = strtolower($t['category_type'].'|'.$t['category_name']);
    $catSet[$key] = ['name'=>$t['category_name'], 'type'=>$t['category_type'], 'color'=>$t['category_color']];
  }
  foreach ($budgets as $b) {
    $key = strtolower($b['category_type'].'|'.$b['category_name']);
    $catSet[$key] = ['name'=>$b['category_name'], 'type'=>$b['category_type'], 'color'=>$b['category_color']];
  }
  $cats = array_values($catSet);

  ok([
    'month_key' => $mk,
    'goal' => ['savings_goal' => $goalVal],
    'categories' => $cats,
    'budgets' => array_map(fn($b)=>[
      'category_name'=>$b['category_name'],
      'category_type'=>$b['category_type'],
      'category_color'=>$b['category_color'],
      'budget_amount'=>(int)$b['budget_amount'],
    ], $budgets),
    'transactions' => array_map(fn($t)=>[
      'tdate'=>$t['tdate'],
      'category_name'=>$t['category_name'],
      'category_type'=>$t['category_type'],
      'category_color'=>$t['category_color'],
      'amount'=>(int)$t['amount'],
      'note'=>$t['note'],
    ], $txs),
  ]);
}

// POST /api/month/import  { payload: {..export json..}, overwrite: true|false }
if ($path === '/month/import' && $method === 'POST') {
  $b = json_in();
  $payload = $b['payload'] ?? null;
  $overwrite = !empty($b['overwrite']);

  if (!is_array($payload)) err('payload required (export JSON)');
  $mk = trim((string)($payload['month_key'] ?? ''));
  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('payload.month_key must be YYYY-MM');

  $db->beginTransaction();

  try {
    // ensure month exists
    $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$mk]);
    $db->prepare("INSERT OR IGNORE INTO goals(month_key, savings_goal) VALUES(?,0)")->execute([$mk]);

    // check existing data
    $stHasTx = $db->prepare("SELECT COUNT(*) FROM transactions WHERE month_key=?");
    $stHasTx->execute([$mk]);
    $hasTx = (int)$stHasTx->fetchColumn();

    $stHasB = $db->prepare("SELECT COUNT(*) FROM budgets WHERE month_key=?");
    $stHasB->execute([$mk]);
    $hasB = (int)$stHasB->fetchColumn();

    $hasAny = ($hasTx > 0) || ($hasB > 0);

    if ($hasAny && !$overwrite) {
      $db->rollBack();
      err('Target month already has data. Re-try import with overwrite=true.', 409);
    }

    if ($overwrite) {
      $db->prepare("DELETE FROM transactions WHERE month_key=?")->execute([$mk]);
      $db->prepare("DELETE FROM budgets WHERE month_key=?")->execute([$mk]);
      $db->prepare("UPDATE goals SET savings_goal=0 WHERE month_key=?")->execute([$mk]);
    }

    // helper: get or create category by name+type
    $getCat = function($name, $type, $color) use ($db) {
      $name = trim((string)$name);
      $type = trim((string)$type);
      $color = trim((string)$color);

      $st = $db->prepare("SELECT id FROM categories WHERE lower(name)=lower(?) AND type=? LIMIT 1");
      $st->execute([$name, $type]);
      $id = $st->fetchColumn();
      if ($id) return (int)$id;

      $st2 = $db->prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)");
      $st2->execute([$name, $type, $color ?: '#BFC3E6']);
      return (int)$db->lastInsertId();
    };

    // budgets
    $budgets = $payload['budgets'] ?? [];
    if (is_array($budgets)) {
      $stUp = $db->prepare("
        INSERT INTO budgets(month_key, category_id, budget_amount)
        VALUES(?,?,?)
        ON CONFLICT(month_key, category_id) DO UPDATE SET budget_amount=excluded.budget_amount
      ");

      foreach ($budgets as $bb) {
        if (!is_array($bb)) continue;
        $cid = $getCat($bb['category_name'] ?? '', $bb['category_type'] ?? 'expense', $bb['category_color'] ?? '');
        $amt = (int)($bb['budget_amount'] ?? 0);
        if ($amt < 0) $amt = 0;
        $stUp->execute([$mk, $cid, $amt]);
      }
    }

    // goal
    $goal = $payload['goal'] ?? null;
    if (is_array($goal)) {
      $g = (int)($goal['savings_goal'] ?? 0);
      if ($g < 0) $g = 0;
      $db->prepare("UPDATE goals SET savings_goal=? WHERE month_key=?")->execute([$g, $mk]);
    }

    // transactions
    $txs = $payload['transactions'] ?? [];
    if (is_array($txs)) {
      $stIns = $db->prepare("INSERT INTO transactions(month_key, category_id, amount, tdate, note) VALUES(?,?,?,?,?)");

      foreach ($txs as $t) {
        if (!is_array($t)) continue;
        $cid = $getCat($t['category_name'] ?? '', $t['category_type'] ?? 'expense', $t['category_color'] ?? '');
        $amt = (int)($t['amount'] ?? 0);
        $date = (string)($t['tdate'] ?? '');
        $note = (string)($t['note'] ?? '');

        if ($amt <= 0) continue;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) continue;
        if (substr($date, 0, 7) !== $mk) continue;

        $stIns->execute([$mk, $cid, $amt, $date, $note]);
      }
    }

    $db->commit();
    ok(['ok'=>true, 'month_key'=>$mk]);
  } catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    err('Import failed: '.$e->getMessage(), 500);
  }
}

// GET /api/trends?months=6
if ($path === '/trends' && $method === 'GET') {
  $n = (int)($_GET['months'] ?? 6);
  if ($n < 1) $n = 1;
  if ($n > 24) $n = 24;

  $sql = "
    WITH m AS (
      SELECT month_key
      FROM months
      ORDER BY month_key DESC
      LIMIT :n
    ),
    s AS (
      SELECT
        t.month_key,
        SUM(CASE WHEN c.type='income' THEN t.amount ELSE 0 END) AS income,
        SUM(CASE WHEN c.type='expense' THEN t.amount ELSE 0 END) AS expenses
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      GROUP BY t.month_key
    )
    SELECT
      m.month_key,
      COALESCE(s.income,0) AS income,
      COALESCE(s.expenses,0) AS expenses,
      COALESCE(g.savings_goal,0) AS savings_goal
    FROM m
    LEFT JOIN s ON s.month_key = m.month_key
    LEFT JOIN goals g ON g.month_key = m.month_key
    ORDER BY m.month_key ASC
  ";

  $st = $db->prepare($sql);
  $st->bindValue(':n', $n, PDO::PARAM_INT);
  $st->execute();

  $rows = $st->fetchAll(PDO::FETCH_ASSOC);
  ok(['months' => array_map(fn($r) => [
    'month_key' => $r['month_key'],
    'income' => (int)$r['income'],
    'expenses' => (int)$r['expenses'],
    'savings_goal' => (int)$r['savings_goal'],
  ], $rows)]);
}

// GET /api/trends/export?months=12
if ($path === '/trends/export' && $method === 'GET') {
  $n = (int)($_GET['months'] ?? 12);
  if ($n < 1) $n = 1;
  if ($n > 24) $n = 24;

  $sql = "
    WITH m AS (
      SELECT month_key
      FROM months
      ORDER BY month_key DESC
      LIMIT :n
    ),
    s AS (
      SELECT
        t.month_key,
        SUM(CASE WHEN c.type='income' THEN t.amount ELSE 0 END) AS income,
        SUM(CASE WHEN c.type='expense' THEN t.amount ELSE 0 END) AS expenses
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      GROUP BY t.month_key
    )
    SELECT
      m.month_key,
      COALESCE(s.income,0) AS income,
      COALESCE(s.expenses,0) AS expenses,
      COALESCE(g.savings_goal,0) AS savings_goal
    FROM m
    LEFT JOIN s ON s.month_key = m.month_key
    LEFT JOIN goals g ON g.month_key = m.month_key
    ORDER BY m.month_key ASC
  ";

  $st = $db->prepare($sql);
  $st->bindValue(':n', $n, PDO::PARAM_INT);
  $st->execute();
  $rows = $st->fetchAll(PDO::FETCH_ASSOC);

  $csv = [];
  $csv[] = ['month','income','expenses','balance','savings_goal'];

  foreach ($rows as $r) {
    $inc = (int)$r['income'];
    $exp = (int)$r['expenses'];
    $bal = $inc - $exp;
    $goal = (int)$r['savings_goal'];
    $csv[] = [$r['month_key'], $inc, $exp, $bal, $goal];
  }

  send_csv("trends-last-$n-months.csv", $csv);
}

// POST /api/goals  { month_key:"YYYY-MM", savings_goal: 12000 }
if ($path === '/goals' && $method === 'POST') {
  $b = json_in();
  $mk = trim((string)($b['month_key'] ?? ''));
  $goal = (int)($b['savings_goal'] ?? 0);

  if (!preg_match('/^\d{4}-\d{2}$/', $mk)) err('month_key must be YYYY-MM');
  if ($goal < 0) $goal = 0;

  $db->prepare("INSERT OR IGNORE INTO months(month_key) VALUES(?)")->execute([$mk]);

  $st = $db->prepare("
    INSERT INTO goals(month_key, savings_goal)
    VALUES(?,?)
    ON CONFLICT(month_key) DO UPDATE SET savings_goal=excluded.savings_goal
  ");
  $st->execute([$mk, $goal]);

  ok(['ok'=>true]);
}

// DELETE /api/reset - Clear all data (for reset button)
if ($path === '/reset' && $method === 'DELETE') {
  try {
    $db->beginTransaction();
    
    // Delete all data from all tables
    $db->exec("DELETE FROM transactions");
    $db->exec("DELETE FROM months");
    $db->exec("DELETE FROM categories");
    $db->exec("DELETE FROM goals");
    $db->exec("DELETE FROM budgets");
    $db->exec("DELETE FROM recurring_templates");
    $db->exec("DELETE FROM recurring_runs");
    
    // Re-seed default categories
    $seed = [
      ['Salary','income','#08F850'],
      ['Side Gigs','income','#58D8B0'],
      ['Groceries','expense','#E82888'],
      ['Transport','expense','#7028F8'],
      ['Bills','expense','#F0A810'],
    ];
    $st = $db->prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)");
    foreach ($seed as $c) $st->execute($c);
    
    $db->commit();
    ok(['ok' => true, 'message' => 'All data cleared']);
  } catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    err('Reset failed: ' . $e->getMessage(), 500);
  }
}

err('Not found', 404);
