/** How Laravel writes to stderr, which the containers send to CloudWatch. */
export type LogFormat = 'json' | 'text';

/** Monolog's JSON formatter, which every Laravel app has. */
export const MONOLOG_JSON_FORMATTER = 'Monolog\\Formatter\\JsonFormatter';

/**
 * The `LOG_STDERR_FORMATTER` the containers get when the environment sets
 * none, or nothing for `text`. Laravel's `stderr` log channel reads it.
 */
export function stderrLogFormatter(format: unknown = 'json'): string | undefined {
  if (format !== 'json' && format !== 'text') {
    throw new Error(`config.logFormat must be "json" or "text", not ${JSON.stringify(format)}.`);
  }

  return format === 'json' ? MONOLOG_JSON_FORMATTER : undefined;
}
