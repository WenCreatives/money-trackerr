<?php
// Router for PHP built-in server to handle /api routes
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Route /api/* requests to ../api/index.php
if (preg_match('#^/api/#', $uri)) {
    $_SERVER['REQUEST_URI'] = $uri;
    require_once __DIR__ . '/../api/index.php';
    return true;
}

// Let PHP built-in server handle static files (return false)
return false;
