<?php

// A stand-in for Laravel's front controller: `/up` answers like Laravel's
// health route, `/env?name=X` shows the environment variable X, and
// `/log?bytes=N` writes a JSON line of about N bytes to stderr, the way
// Laravel's stderr log channel does.

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/up') {
    echo 'up';
    return;
}

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/env') {
    echo getenv($_GET['name'] ?? '');
    return;
}

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/log') {
    $line = json_encode(['message' => 'long line', 'trace' => str_repeat('x', (int) ($_GET['bytes'] ?? 100))]);
    file_put_contents('php://stderr', $line."\n");
    echo strlen($line);
    return;
}

http_response_code(404);
