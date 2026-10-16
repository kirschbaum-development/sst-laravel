<?php

// A stand-in for Laravel's front controller: `/up` answers like Laravel's
// health route, and `/env?name=X` shows the environment variable X.

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/up') {
    echo 'up';
    return;
}

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/env') {
    echo getenv($_GET['name'] ?? '');
    return;
}

http_response_code(404);
