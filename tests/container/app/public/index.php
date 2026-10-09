<?php

// A stand-in for Laravel's front controller: `/up` answers like Laravel's
// health route.

if (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/up') {
    echo 'up';
    return;
}

http_response_code(404);
