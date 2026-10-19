<?php

namespace Kirschbaum\SST\Logging;

use Kirschbaum\SST\Monitoring\TaskContext;
use Monolog\Formatter\JsonFormatter as MonologJsonFormatter;
use Monolog\LogRecord;

/**
 * One JSON line per log entry, stack trace included, so CloudWatch keeps an
 * entry and its trace together. `extra` says where it came from: the
 * service, the ECS task, and the deploy (task definition revision). SST
 * Laravel sets it as `LOG_STDERR_FORMATTER` when the app installs this
 * package and doesn't set one.
 */
class JsonFormatter extends MonologJsonFormatter
{
    /**
     * The longest line it writes. ECS on Fargate splits a line of more than
     * 16 KB into several log events, which would break the JSON, so longer
     * entries lose the end of their stack traces, then of their message.
     */
    public const MAX_LINE_BYTES = 16000;

    public function __construct()
    {
        parent::__construct(self::BATCH_MODE_NEWLINES, true, true, true);
    }

    public function format(LogRecord $record): string
    {
        $data = $this->normalizeRecord($record);
        $json = $this->toJson($data, true);

        if (strlen($json) >= self::MAX_LINE_BYTES) {
            $json = $this->toJson($this->fit($data, strlen($json)), true);
        }

        return $json.($this->appendNewline ? "\n" : '');
    }

    /** @return array<array-key, mixed> */
    protected function normalizeRecord(LogRecord $record): array
    {
        $data = parent::normalizeRecord($record);
        $context = TaskContext::fields();

        if ($context !== []) {
            $data['extra'] = array_merge($context, is_array($data['extra'] ?? null) ? $data['extra'] : []);
        }

        if (is_array($data['context']['exception'] ?? null)) {
            $frame = self::appFrame($data['context']['exception']);

            if ($frame !== null) {
                $data['context']['exception']['app_frame'] = $frame;
            }
        }

        return $data;
    }

    /**
     * Where the app's own code is in an exception's trace: the first frame
     * outside `vendor/` and the entry points (`artisan`, `public/index.php`).
     * `sst-laravel logs:errors` groups the errors by it, so a database error
     * that Laravel throws in `Connection.php` is grouped by the query of the
     * app that ran into it.
     *
     * @param  array<array-key, mixed>  $exception
     */
    public static function appFrame(array $exception): ?string
    {
        $frames = [$exception['file'] ?? null, ...(is_array($exception['trace'] ?? null) ? $exception['trace'] : [])];

        foreach ($frames as $frame) {
            if (! is_string($frame) || ! preg_match('/^(.+):\d+$/', $frame, $match)) {
                continue;
            }

            $file = $match[1];

            // Relative to the app with Monolog's `setBasePath()`.
            if (! preg_match('#(^|/)vendor/#', $file) && ! str_starts_with($file, 'internal[') && ! preg_match('#(^|/)(artisan|public/index\.php)$#', $file)) {
                return $frame;
            }
        }

        return null;
    }

    /**
     * @param  array<array-key, mixed>  $data
     * @return array<array-key, mixed>
     */
    private function fit(array $data, int $length): array
    {
        $traces = [];

        if (is_array($data['context'] ?? null)) {
            $this->collectTraces($data['context'], $traces);
        }

        // First the strings of over 4 KB in the context and extra.
        $length = $this->capFields($data, $length, 4096);

        // Then halve the longest trace until the line fits, keeping the frames
        // nearest to where each exception was thrown.
        while ($length >= self::MAX_LINE_BYTES && $traces !== []) {
            usort($traces, fn ($a, $b) => count($b['frames']) <=> count($a['frames']));
            $longest = &$traces[0];
            $kept = intdiv(count($longest['frames']), 2);
            $longest['omitted'] += count($longest['frames']) - $kept;
            $longest['frames'] = array_slice($longest['frames'], 0, $kept);
            $longest['exception']['trace'] = [...$longest['frames'], "[{$longest['omitted']} more frames]"];

            unset($longest);

            if ($kept === 0) {
                array_shift($traces);
            }

            $length = strlen($this->toJson($data, true));
        }

        // Then the strings of the context and extra, such as an exception's
        // message, and the message, down to their first KB.
        $length = $this->capFields($data, $length, 1024);
        [$data, $length] = $this->cutMessage($data, $length, 1024);

        // Last, the context, then all of extra but where the entry came from.
        if ($length >= self::MAX_LINE_BYTES && ($data['context'] ?? []) !== []) {
            $data['context'] = ['sst_laravel_truncated' => "The context made the entry {$length} bytes long."];
            $length = strlen($this->toJson($data, true));
        }

        if ($length >= self::MAX_LINE_BYTES && is_array($data['extra'] ?? null)) {
            $data['extra'] = array_intersect_key($data['extra'], array_flip(['service', 'ecs_task', 'revision']))
                + ['sst_laravel_truncated' => "The extra fields made the entry {$length} bytes long."];
            $length = strlen($this->toJson($data, true));
        }

        return $this->cutMessage($data, $length, 0)[0];
    }

    /**
     * Shortens the message until the line fits, but not below `$floor` bytes.
     *
     * @param  array<array-key, mixed>  $data
     * @return array{0: array<array-key, mixed>, 1: int}
     */
    private function cutMessage(array $data, int $length, int $floor): array
    {
        // Escaping can make the message longer in JSON than it is: try again.
        for ($attempt = 0; $length >= self::MAX_LINE_BYTES && is_string($data['message'] ?? null) && $attempt < 8; $attempt++) {
            $message = preg_replace('/ \[truncated\]$/', '', $data['message']);
            $keep = max($floor, strlen($message) - ($length - self::MAX_LINE_BYTES) * ($attempt + 1) - 64);

            if ($keep >= strlen($message)) {
                break;
            }

            $data['message'] = mb_strcut($message, 0, $keep, 'UTF-8').' [truncated]';
            $length = strlen($this->toJson($data, true));
        }

        return [$data, $length];
    }

    /** @param  array<array-key, mixed>  $data */
    private function capFields(array &$data, int $length, int $max): int
    {
        foreach (['context', 'extra'] as $key) {
            if ($length >= self::MAX_LINE_BYTES && is_array($data[$key] ?? null)) {
                $this->capStrings($data[$key], $max);
                $length = strlen($this->toJson($data, true));
            }
        }

        return $length;
    }

    /** @param  array<array-key, mixed>  $value */
    private function capStrings(array &$value, int $max): void
    {
        foreach ($value as &$child) {
            if (is_string($child) && strlen($child) > $max) {
                $child = mb_strcut($child, 0, $max, 'UTF-8').' [truncated]';
            } elseif (is_array($child)) {
                $this->capStrings($child, $max);
            }
        }
    }

    /**
     * Gathers references to each normalized exception's trace (its previous
     * exceptions' too) under the context.
     *
     * @param  array<array-key, mixed>  $value
     * @param  list<array{exception: array<array-key, mixed>, frames: list<mixed>, omitted: int}>  $traces
     */
    private function collectTraces(array &$value, array &$traces): void
    {
        if (isset($value['class'], $value['trace']) && is_array($value['trace'])) {
            $traces[] = ['exception' => &$value, 'frames' => array_values($value['trace']), 'omitted' => 0];
        }

        foreach ($value as &$child) {
            if (is_array($child)) {
                $this->collectTraces($child, $traces);
            }
        }
    }
}
