<?php

namespace Kirschbaum\SST\Monitoring;

/**
 * Where the code runs, for log lines: the service (`SST_LARAVEL_SERVICE`,
 * which the component sets: `web`, `reverb`, or the worker name), the ECS
 * task ID, and the deploy, as the task definition revision
 * (`<family>:<revision>`, the revision `sst-laravel status` reports). The
 * task metadata comes from the ECS task metadata endpoint, read once per
 * container and cached in the temporary directory.
 */
final class TaskContext
{
    /** @var array<string, string>|null */
    private static ?array $fields = null;

    /** True in a container SST Laravel deployed. */
    public static function inContainer(): bool
    {
        return self::env('SST_LARAVEL_SERVICE') !== null;
    }

    /**
     * `service`, `ecs_task`, and `revision`, as far as they are known.
     *
     * @return array<string, string>
     */
    public static function fields(): array
    {
        if (self::$fields !== null) {
            return self::$fields;
        }

        $service = self::env('SST_LARAVEL_SERVICE');

        return self::$fields = ($service !== null ? ['service' => $service] : []) + self::taskMetadata();
    }

    /** Forgets the cached fields (for tests). */
    public static function flush(): void
    {
        self::$fields = null;
    }

    /** @return array<string, string> */
    private static function taskMetadata(): array
    {
        $uri = self::env('ECS_CONTAINER_METADATA_URI_V4');

        if ($uri === null) {
            return [];
        }

        $cache = rtrim(sys_get_temp_dir(), '/').'/sst-laravel-task-'.md5($uri).'.json';

        if (is_readable($cache)) {
            $cached = json_decode((string) @file_get_contents($cache), true);

            if (is_array($cached)) {
                return $cached;
            }
        }

        $body = @file_get_contents(rtrim($uri, '/').'/task', false, stream_context_create(['http' => ['timeout' => 1]]));
        $task = is_string($body) ? json_decode($body, true) : null;

        if (! is_array($task) || ! is_string($task['TaskARN'] ?? null)) {
            return [];
        }

        $arn = $task['TaskARN'];
        $fields = ['ecs_task' => substr($arn, strrpos($arn, '/') === false ? 0 : strrpos($arn, '/') + 1)];

        if (isset($task['Family'], $task['Revision'])) {
            $fields['revision'] = $task['Family'].':'.$task['Revision'];
        }

        // Written whole, then renamed, so another process never reads half of it.
        $temporary = $cache.'.'.getmypid();

        if (@file_put_contents($temporary, json_encode($fields)) !== false) {
            @rename($temporary, $cache);
        }

        return $fields;
    }

    private static function env(string $name): ?string
    {
        $value = getenv($name);

        if ($value === false || $value === '') {
            $value = $_SERVER[$name] ?? $_ENV[$name] ?? null;
        }

        return is_string($value) && $value !== '' ? $value : null;
    }
}
