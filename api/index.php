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
      t.id, t.amount, t.tdate, COALESCE(t.note,'') AS note,
      c.name AS category_name, c.type AS category_type, c.color AS category_color
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

    // NEW goal fields
    'savings_goal' => $goal,
    'savings_progress' => $progress,   // 0..1
    'savings_diff' => $diff,           // balance - goal
    'overspend' => $overspend,
    'overspend_amount' => $overspendAmount
  ]);
}

err('Not found', 404);
