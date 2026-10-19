<?php

$env = static fn (string $name, mixed $default = null): mixed => $_ENV[$name] ?? $_SERVER[$name] ?? $default;

return [
    'binary' => $env('SST_LARAVEL_BINARY'),

    /*
     * In the containers SST Laravel deploys, log failed jobs and scheduled
     * task runs as JSON lines, and sample the queue sizes every minute from
     * the scheduler, for `sst-laravel queue:status`.
     */
    'monitoring' => [
        'enabled' => filter_var($env('SST_LARAVEL_MONITORING', true), FILTER_VALIDATE_BOOL),

        'sample_queues' => filter_var($env('SST_LARAVEL_SAMPLE_QUEUES', true), FILTER_VALIDATE_BOOL),

        // The queues to sample, as `connection:queue` or a queue of the
        // default connection. Empty: the default queue and Horizon's queues.
        'queues' => array_values(array_filter(array_map('trim', explode(',', (string) $env('SST_LARAVEL_QUEUES', ''))))),
    ],
];
