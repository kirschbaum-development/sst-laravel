import * as fs from 'fs';
import * as path from 'path';

/** How Laravel writes to stderr, which the containers send to CloudWatch. */
export type LogFormat = 'json' | 'text';

/** The package's formatter: JSON with the stack trace, and the service, task, and deploy. */
export const PACKAGE_JSON_FORMATTER = 'Kirschbaum\\SST\\Logging\\JsonFormatter';

/** Monolog's, for apps without the package: JSON, without the stack trace. */
export const MONOLOG_JSON_FORMATTER = 'Monolog\\Formatter\\JsonFormatter';

/** Where Composer installs the package's formatter. */
const PACKAGE_FORMATTER_FILE = 'vendor/kirschbaum-development/sst-laravel/laravel/Logging/JsonFormatter.php';

/**
 * The `LOG_STDERR_FORMATTER` the containers get when the environment sets
 * none, or nothing for `text`. Laravel's `stderr` log channel reads it. The
 * images copy `vendor/` as it is, so the package's formatter is only named
 * when it is installed there; a missing class would send the logs to the
 * emergency log file instead of CloudWatch.
 */
export function stderrLogFormatter(absSitePath: string, format: unknown = 'json'): string | undefined {
  if (format !== 'json' && format !== 'text') {
    throw new Error(`config.logFormat must be "json" or "text", not ${JSON.stringify(format)}.`);
  }

  if (format === 'text') {
    return undefined;
  }

  return fs.existsSync(path.join(absSitePath, PACKAGE_FORMATTER_FILE)) ? PACKAGE_JSON_FORMATTER : MONOLOG_JSON_FORMATTER;
}
