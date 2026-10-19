import { Command } from 'commander';
import { APP_REGION_OPTION_HELP } from '../utils/aws.js';
import { CliError, exitWithError, info, isInteractive } from '../utils/cli.js';
import {
  fetchLogLines,
  followLogLines,
  formatLogLine,
  joinStackTraces,
  LogLine,
  logLineJson,
} from '../utils/log-events.js';
import { selectLogSources } from '../utils/log-sources.js';
import { resolveStageLogs } from '../utils/stage-logs.js';
import { formatWindow, resolveTimeWindow } from '../utils/time.js';

export { stripAnsi } from '../utils/log-events.js';

interface LogsOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  follow?: boolean;
  since?: string;
  start?: string;
  end?: string;
  filter?: string;
  json?: boolean;
  limit: string;
}

export const DEFAULT_LOG_LIMIT = 10000;

/**
 * Follows when asked to with `--follow`, even without a terminal (a script
 * that does should stop it itself), and by default only in a terminal and
 * without `--end`.
 */
export const shouldFollow = (options: Pick<LogsOptions, 'follow' | 'end'>, interactive: boolean): boolean =>
  options.follow ?? (interactive && !options.end);

export const logsCommand = new Command('logs')
  .description('Print or stream the CloudWatch logs of the stage, read from the log groups (no running task needed)')
  .argument('[service]', 'web, reverb, worker (every worker), a worker name, or another task in the cluster (default: all)')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'ECS cluster name or ARN (default: auto-detected from the stage)')
  .option('-r, --region <region>', APP_REGION_OPTION_HELP)
  .option('-f, --follow', 'Keep streaming new lines until stopped (the default only in a terminal)')
  .option('--no-follow', 'Print the lines of the window and exit')
  .option('--since <duration>', 'How far back to start, e.g. 30m, 24h, 7d (default: 10m)')
  .option('--start <time>', 'Start of the window: an ISO 8601 time (UTC unless it has an offset) or a duration ago')
  .option('--end <time>', 'End of the window, exclusive (default: now)')
  .option('--filter <pattern>', 'Only lines matching a CloudWatch filter pattern, e.g. "ERROR" or \'{ $.level_name = "ERROR" }\'')
  .option('--json', 'Print JSON Lines: one object per log line, with service, task, revision, and level')
  .option('--limit <lines>', 'Most lines to read from each log group', String(DEFAULT_LOG_LIMIT))
  .action(async (service: string | undefined, options: LogsOptions) => {
    try {
      const follow = shouldFollow(options, isInteractive());
      const window = resolveTimeWindow(options, '10m');
      const limit = Number(options.limit);

      if (!Number.isInteger(limit) || limit <= 0) {
        throw new CliError('--limit must be a positive whole number.', 2);
      }

      if (follow && options.end) {
        throw new CliError('--follow streams new lines, so it takes no --end.', 2);
      }

      const stage = await resolveStageLogs(options);
      const sources = selectLogSources(stage.sources, service);

      info(`${follow ? 'Streaming' : 'Reading'} ${sources.map((source) => source.service).join(', ')} from ${formatWindow(window)}${follow ? ' onwards' : ''}.`);
      if (follow) {
        info('Press Ctrl+C to stop. Use --no-follow to print the lines and exit.');
      }

      const print = (lines: LogLine[]) => {
        for (const line of joinStackTraces(lines)) {
          process.stdout.write(`${options.json ? JSON.stringify(logLineJson(line)) : formatLogLine(line)}\n`);
        }
      };

      if (follow) {
        await followLogLines(stage.logs, sources, window.start, { filterPattern: options.filter, onLines: print });
        return;
      }

      const result = await fetchLogLines(stage.logs, sources, window, { filterPattern: options.filter, limit });
      print(result.lines);

      if (result.truncatedAt !== undefined) {
        const next = new Date(result.truncatedAt).toISOString();
        info(`Stopped at ${next}: more than ${limit} lines in a log group. Continue with --start ${next}${options.end ? ` --end ${options.end}` : ''}, or narrow with --filter or a service.`);
      } else if (result.lines.length === 0) {
        info('No log lines in the window.');
      }
    } catch (error) {
      await exitWithError(error);
    }
  });
