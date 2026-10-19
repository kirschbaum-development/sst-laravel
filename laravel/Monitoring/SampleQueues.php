<?php

namespace Kirschbaum\SST\Monitoring;

use Illuminate\Contracts\Foundation\Application;
use Throwable;

/**
 * Logs the size of each queue (`queue_size`) and of the failed_jobs table
 * (`failed_jobs_total`). The package schedules it every minute in the
 * containers SST Laravel deploys, so `sst-laravel queue:status` reports the
 * backlog, and notices when the scheduler stops.
 */
final class SampleQueues
{
    public const NAME = 'sst-laravel:sample-queues';

    /** Drivers without a queue to measure. */
    private const UNMEASURED_DRIVERS = ['sync', 'null', 'deferred', 'background', 'failover'];

    public function __construct(private readonly Application $app)
    {
    }

    public function __invoke(): void
    {
        foreach ($this->queues() as [$connection, $queue]) {
            try {
                $size = $this->app['queue']->connection($connection)->size($queue);
                Events::emit('queue_size', ['connection' => $connection, 'queue' => $queue, 'size' => $size]);
            } catch (Throwable $exception) {
                Events::emit('queue_size', ['connection' => $connection, 'queue' => $queue, 'error' => Events::clip($exception->getMessage())]);
            }
        }

        try {
            $failer = $this->app['queue.failer'];

            if (method_exists($failer, 'count')) {
                Events::emit('failed_jobs_total', ['failed_jobs' => $failer->count()]);
            }
        } catch (Throwable) {
            // No failed job store, or it can't be read.
        }
    }

    /**
     * `sst-laravel.monitoring.queues` (`connection:queue` or a queue of the
     * default connection), or else the default connection's queue and the
     * queues of Horizon's supervisors.
     *
     * @return list<array{0: string, 1: string}>
     */
    public function queues(): array
    {
        $config = $this->app['config'];
        $default = (string) $config->get('queue.default');
        $configured = $config->get('sst-laravel.monitoring.queues');
        $queues = [];

        if (is_array($configured) && $configured !== []) {
            foreach ($configured as $entry) {
                [$connection, $queue] = str_contains((string) $entry, ':') ? explode(':', (string) $entry, 2) : [$default, (string) $entry];
                $queues[] = [$connection, $queue];
            }
        } else {
            $queues[] = [$default, (string) ($config->get("queue.connections.$default.queue") ?? 'default')];

            // Horizon runs the supervisors of the environment, over its defaults.
            $environments = (array) $config->get('horizon.environments', []);
            $supervisors = (array) ($environments[$this->app->environment()] ?? $environments['*'] ?? []);

            foreach ($supervisors as $supervisorName => $supervisor) {
                $merged = array_merge((array) $config->get("horizon.defaults.$supervisorName", []), (array) $supervisor);
                $connection = (string) ($merged['connection'] ?? 'redis');

                foreach ((array) ($merged['queue'] ?? ['default']) as $queue) {
                    foreach (explode(',', (string) $queue) as $queueName) {
                        $queues[] = [$connection, trim($queueName)];
                    }
                }
            }
        }

        $unique = [];

        foreach ($queues as [$connection, $queue]) {
            $driver = $config->get("queue.connections.$connection.driver");

            if ($queue === '' || $driver === null || in_array($driver, self::UNMEASURED_DRIVERS, true)) {
                continue;
            }

            $unique["$connection:$queue"] = [$connection, $queue];
        }

        return array_values($unique);
    }
}
