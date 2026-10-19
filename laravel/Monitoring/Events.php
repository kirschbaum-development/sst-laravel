<?php

namespace Kirschbaum\SST\Monitoring;

use Throwable;

/**
 * Writes the package's events as one JSON line each on stderr, which the
 * container sends to CloudWatch, whatever the app's log channel. Each line
 * has `sst_laravel` (the event), `time`, the event's fields, and where it
 * ran (`TaskContext`). `sst-laravel queue:status` reads them.
 */
final class Events
{
    /** @param array<string, mixed> $fields */
    public static function emit(string $event, array $fields): void
    {
        try {
            $line = json_encode(
                ['sst_laravel' => $event, 'time' => gmdate('Y-m-d\TH:i:s\Z')] + $fields + TaskContext::fields(),
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR,
            );

            if ($line !== false) {
                @file_put_contents('php://stderr', $line."\n");
            }
        } catch (Throwable) {
            // Monitoring never breaks the app.
        }
    }

    /** The first line of a message, at most 500 characters. */
    public static function clip(string $message): string
    {
        $line = strtok($message, "\r\n");
        $line = $line === false ? '' : $line;

        return mb_strlen($line) > 500 ? mb_substr($line, 0, 499).'…' : $line;
    }

    /** A path relative to the app, for shorter lines. */
    public static function relative(string $path): string
    {
        $base = function_exists('base_path') ? rtrim(base_path(), '/').'/' : '';

        return $base !== '/' && $base !== '' && str_starts_with($path, $base) ? substr($path, strlen($base)) : $path;
    }

    /** @return array{exception: string, message: string, file: string} */
    public static function exception(Throwable $exception): array
    {
        return [
            'exception' => get_class($exception),
            'message' => self::clip($exception->getMessage()),
            'file' => self::relative($exception->getFile()).':'.$exception->getLine(),
        ];
    }
}
