<?php
declare(strict_types=1);

/**
 * Simple Money Tracker API (PHP + SQLite)
 * Run with:
 *   php -S localhost:8000 -t public
 * API will be served from /api via ../api/index.php using the rewrite in index.html fetch URLs.
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

function json_out($data, int $code = 200): void {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  exit;
}

function body_json(): array {
  $raw = file_get_contents('php://input');
  if (!$raw) return [];
  $decoded = json_decode($raw, true);
  return is_array($decoded) ? $decoded : [];
}

function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;

  $base = dirname(__DIR__);
  $dataDir = $base . DIRECTORY_SEPARATOR . 'data';
  if (!is_dir($dataDir)) mkdir($dataDir, 0777, true);

  $path = $dataDir . DIRECTORY_SEPARATOR . 'app.sqlite';
  $pdo = new PDO('sqlite:' . $path, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
  ]);

  init_db($pdo);
  return $pdo;
}

function init_db(PDO $pdo): void {
  $pdo->exec("
    CREATE TABLE IF NOT EXISTS months (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      tdate TEXT NOT NULL, -- YYYY-MM-DD
      note TEXT,
      FOREIGN KEY(month_id) REFERENCES months(id),
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );
  ");

  // Seed default categories (only if empty)
  $count = (int)$pdo->query("SELECT COUNT(*) AS c FROM categories")->fetch()['c'];
  if ($count === 0) {
    $seed = [
      ['Salary','income','#08F850'],
      ['Side Gigs','income','#58D8B0'],
      ['Groceries','expense','#E82888'],
      ['Transport','expense','#7028F8'],
      ['Eating Out','expense','#F0A810'],
      ['Misc','expense','#E02020'],
    ];
    $stmt = $pdo->prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)");
    foreach ($seed as $s) $stmt->execute($s);
  }
}

function ensure_month(PDO $pdo, string $month_key): int {
  if (!preg_match('/^\d{4}-\d{2}$/', $month_key)) {
    json_out(['error' => 'Invalid month_key. Use YYYY-MM'], 400);
  }
  $stmt = $pdo->prepare("SELECT id FROM months WHERE month_key = ?");
  $stmt->execute([$month_key]);
  $row = $stmt->fetch();
  if ($row) return (int)$row['id'];

  $ins = $pdo->prepare("INSERT INTO months(month_key) VALUES(?)");
  $ins->execute([$month_key]);
  return (int)$pdo->lastInsertId();
}

function route(): array {
  $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';
  // Expect /api/... if served behind public
  $uri = preg_replace('#^/api#', '', $uri);
  $parts = array_values(array_filter(explode('/', $uri), fn($p) => $p !== ''));
  return $parts;
}

$pdo = db();
$parts = route();
$method = $_SERVER['REQUEST_METHOD'];

$resource = $parts[0] ?? '';
$id = $parts[1] ?? null;

/**
 * Endpoints:
 * GET    /api/months
 * POST   /api/months            {month_key}
 *
 * GET    /api/categories
 * POST   /api/categories        {name,type,color}
 * PUT    /api/categories/{id}
 * DELETE /api/categories/{id}
 *
 * GET    /api/transactions?month=YYYY-MM
 * POST   /api/transactions      {month_key, category_id, amount, date(YYYY-MM-DD), note}
 * PUT    /api/transactions/{id}
 * DELETE /api/transactions/{id}
 *
 * GET    /api/summary?month=YYYY-MM
 */

if ($resource === 'months') {
  if ($method === 'GET') {
    $rows = $pdo->query("SELECT month_key FROM months ORDER BY month_key DESC")->fetchAll();
    json_out(['months' => array_map(fn($r)=>$r['month_key'], $rows)]);
  }
  if ($method === 'POST') {
    $b = body_json();
    $mk = (string)($b['month_key'] ?? '');
    $monthId = ensure_month($pdo, $mk);
    json_out(['ok' => true, 'month_id' => $monthId, 'month_key' => $mk]);
  }
  json_out(['error' => 'Method not allowed'], 405);
}

if ($resource === 'categories') {
  if ($method === 'GET') {
    $rows = $pdo->query("SELECT * FROM categories ORDER BY type, name")->fetchAll();
    json_out(['categories' => $rows]);
  }
  if ($method === 'POST') {
    $b = body_json();
    $name = trim((string)($b['name'] ?? ''));
    $type = (string)($b['type'] ?? '');
    $color = (string)($b['color'] ?? '#08F850');
    if ($name === '' || !in_array($type, ['income','expense'], true)) {
      json_out(['error' => 'Invalid category payload'], 400);
    }
    $stmt = $pdo->prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)");
    $stmt->execute([$name,$type,$color]);
    json_out(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
  }
  if ($method === 'PUT' && $id) {
    $b = body_json();
    $name = trim((string)($b['name'] ?? ''));
    $type = (string)($b['type'] ?? '');
    $color = (string)($b['color'] ?? '#08F850');
    if ($name === '' || !in_array($type, ['income','expense'], true)) {
      json_out(['error' => 'Invalid category payload'], 400);
    }
    $stmt = $pdo->prepare("UPDATE categories SET name=?, type=?, color=? WHERE id=?");
    $stmt->execute([$name,$type,$color,(int)$id]);
    json_out(['ok' => true]);
  }
  if ($method === 'DELETE' && $id) {
    // Prevent delete if used by transactions
    $chk = $pdo->prepare("SELECT COUNT(*) AS c FROM transactions WHERE category_id=?");
    $chk->execute([(int)$id]);
    if ((int)$chk->fetch()['c'] > 0) {
      json_out(['error' => 'Category in use. Delete related transactions first.'], 409);
    }
    $stmt = $pdo->prepare("DELETE FROM categories WHERE id=?");
    $stmt->execute([(int)$id]);
    json_out(['ok' => true]);
  }
  json_out(['error' => 'Method not allowed'], 405);
}

if ($resource === 'transactions') {
  if ($method === 'GET') {
    $mk = (string)($_GET['month'] ?? '');
    if ($mk === '') json_out(['error' => 'month query param required'], 400);
    $monthId = ensure_month($pdo, $mk);

    $stmt = $pdo->prepare("
      SELECT t.*, c.name AS category_name, c.type AS category_type, c.color AS category_color
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      WHERE t.month_id = ?
      ORDER BY t.tdate DESC, t.id DESC
    ");
    $stmt->execute([$monthId]);
    json_out(['transactions' => $stmt->fetchAll()]);
  }

  if ($method === 'POST') {
    $b = body_json();
    $mk = (string)($b['month_key'] ?? '');
    $category_id = (int)($b['category_id'] ?? 0);
    $amount = (float)($b['amount'] ?? 0);
    $date = (string)($b['date'] ?? '');
    $note = (string)($b['note'] ?? '');

    if ($mk === '' || $category_id <= 0 || $amount <= 0 || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
      json_out(['error' => 'Invalid transaction payload'], 400);
    }
    $monthId = ensure_month($pdo, $mk);

    $stmt = $pdo->prepare("INSERT INTO transactions(month_id, category_id, amount, tdate, note) VALUES(?,?,?,?,?)");
    $stmt->execute([$monthId, $category_id, $amount, $date, $note]);
    json_out(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
  }

  if ($method === 'PUT' && $id) {
    $b = body_json();
    $category_id = (int)($b['category_id'] ?? 0);
    $amount = (float)($b['amount'] ?? 0);
    $date = (string)($b['date'] ?? '');
    $note = (string)($b['note'] ?? '');

    if ($category_id <= 0 || $amount <= 0 || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
      json_out(['error' => 'Invalid transaction payload'], 400);
    }
    $stmt = $pdo->prepare("UPDATE transactions SET category_id=?, amount=?, tdate=?, note=? WHERE id=?");
    $stmt->execute([$category_id, $amount, $date, $note, (int)$id]);
    json_out(['ok' => true]);
  }

  if ($method === 'DELETE' && $id) {
    $stmt = $pdo->prepare("DELETE FROM transactions WHERE id=?");
    $stmt->execute([(int)$id]);
    json_out(['ok' => true]);
  }

  json_out(['error' => 'Method not allowed'], 405);
}

if ($resource === 'summary') {
  if ($method !== 'GET') json_out(['error' => 'Method not allowed'], 405);

  $mk = (string)($_GET['month'] ?? '');
  if ($mk === '') json_out(['error' => 'month query param required'], 400);
  $monthId = ensure_month($pdo, $mk);

  // Totals
  $stmt = $pdo->prepare("
    SELECT
      SUM(CASE WHEN c.type='income' THEN t.amount ELSE 0 END) AS total_income,
      SUM(CASE WHEN c.type='expense' THEN t.amount ELSE 0 END) AS total_expenses
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.month_id = ?
  ");
  $stmt->execute([$monthId]);
  $tot = $stmt->fetch() ?: ['total_income'=>0,'total_expenses'=>0];
  $income = (float)($tot['total_income'] ?? 0);
  $expenses = (float)($tot['total_expenses'] ?? 0);
  $balance = $income - $expenses;

  // Highest spending category (expense)
  $stmt2 = $pdo->prepare("
    SELECT c.id, c.name, c.color, SUM(t.amount) AS amount
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.month_id = ? AND c.type='expense'
    GROUP BY c.id, c.name, c.color
    ORDER BY amount DESC
    LIMIT 1
  ");
  $stmt2->execute([$monthId]);
  $top = $stmt2->fetch();

  // Breakdown for charts (by category)
  $stmt3 = $pdo->prepare("
    SELECT c.id, c.name, c.type, c.color, SUM(t.amount) AS amount
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.month_id = ?
    GROUP BY c.id, c.name, c.type, c.color
    ORDER BY c.type, amount DESC
  ");
  $stmt3->execute([$monthId]);
  $breakdown = $stmt3->fetchAll();

  json_out([
    'month_key' => $mk,
    'total_income' => $income,
    'total_expenses' => $expenses,
    'balance' => $balance,
    'highest_spend' => $top ? [
      'id' => (int)$top['id'],
      'name' => $top['name'],
      'color' => $top['color'],
      'amount' => (float)$top['amount']
    ] : null,
    'breakdown' => array_map(function($r){
      return [
        'id' => (int)$r['id'],
        'name' => $r['name'],
        'type' => $r['type'],
        'color' => $r['color'],
        'amount' => (float)$r['amount']
      ];
    }, $breakdown)
  ]);
}

json_out(['error' => 'Not found'], 404);
