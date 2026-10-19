import { Command } from 'commander';
import { APP_REGION_OPTION_HELP } from '../utils/aws.js';
import { EXIT_ATTENTION, EXIT_ERROR, EXIT_OK, exitAfterOutput, exitWithError, info, printJson } from '../utils/cli.js';
import { InsightsRow, insightsLogGroup, insightsTimeToIso, runInsightsQuery } from '../utils/insights.js';
import { taskIdFromStream } from '../utils/log-events.js';
import { LogSource, selectLogSources } from '../utils/log-sources.js';
import { resolveStageLogs } from '../utils/stage-logs.js';
import { formatWindow, resolveTimeWindow } from '../utils/time.js';

interface LogsErrorsOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  since?: string;
  start?: string;
  end?: string;
  json?: boolean;
  limit: string;
}

/**
 * Groups the error lines of the window, from JSON Laravel logs (Monolog's
 * `level`, `level_name`, `message`, `context.exception`), text Laravel logs
 * (`[time] env.ERROR: message {"exception":"[object] (Class(code: 0): ... at
 * /path:line)`), and PHP fatal errors. An error with an exception is keyed
 * by its class and the first frame of the app's own code in its trace
 * (`context.exception.app_frame`, from the package's formatter), or else
 * the file that threw it; one without, by its message.
 */
export const errorsQuery = (limit: number) => `fields @timestamp, @log, @logStream
| filter level >= 400 or @message like /\\.(ERROR|CRITICAL|ALERT|EMERGENCY): / or @message like /PHP (Fatal|Parse) error/
| parse @message /^\\[[^\\]]+\\] [^.\\s]+\\.(?<tlevel>[A-Z]+): (?<tmessage>[^{]*)/
| parse @message /\\[object\\] \\((?<tclass>[^(]+)\\(code/
| parse @message / at (?<tfile>\\/[^ ]+:\\d+)\\)/
| parse @message /(?<pclass>PHP Fatal error|PHP Parse error): +(?<pmessage>.+) in (?<pfile>\\/[^ ]+ on line \\d+|\\/[^ ]+:\\d+)/
| fields coalesce(message, tmessage, pmessage) as errorMessage
| fields coalesce(context.exception.class, tclass, pclass) as errorClass
| fields coalesce(errorClass, errorMessage) as errorKey
| fields coalesce(context.exception.file, tfile, pfile) as thrownFile
| fields coalesce(context.exception.app_frame, thrownFile) as errorFile
| fields coalesce(level_name, tlevel, "CRITICAL") as errorLevel
| stats count(*) as count, min(@timestamp) as firstSeen, max(@timestamp) as lastSeen, latest(errorClass) as class, latest(errorMessage) as lastMessage, latest(thrownFile) as lastThrownAt, latest(@log) as lastLog, latest(@logStream) as lastStream by errorKey, errorFile, errorLevel
| sort count desc
| limit ${limit}`;

export interface ErrorGroup {
  class: string | null;
  message: string;
  /** The first frame of the app's own code, with the package's formatter, or else where it was thrown. */
  file: string | null;
  /** Where the latest one was thrown, when it isn't `file`. */
  thrownAt?: string;
  level: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  /** Where the latest one came from. */
  service: string | null;
  task: string | null;
}

/**
 * A class name as it is: text logs JSON-encode the exception into their
 * context, so its backslashes arrive doubled (`Illuminate\\Database\\...`).
 */
const unescapeClass = (value: string) => value.replace(/\\\\/g, '\\');

export function toErrorGroup(row: InsightsRow, sources: LogSource[]): ErrorGroup {
  const logGroup = insightsLogGroup(row.lastLog);
  const file = row.errorFile?.trim() || null;
  const thrownAt = row.lastThrownAt?.trim();

  return {
    class: row.class?.trim() ? unescapeClass(row.class.trim()) : null,
    message: (row.lastMessage ?? row.errorKey ?? '').trim(),
    file,
    ...(thrownAt && thrownAt !== file ? { thrownAt } : {}),
    level: row.errorLevel || 'ERROR',
    count: Number(row.count ?? 0),
    firstSeen: insightsTimeToIso(row.firstSeen),
    lastSeen: insightsTimeToIso(row.lastSeen),
    service: sources.find((source) => source.logGroup === logGroup)?.service ?? null,
    task: row.lastStream ? taskIdFromStream(row.lastStream) ?? null : null,
  };
}

/**
 * Merges the groups that only differ by how their class was written: the
 * same exception from a JSON log and from a text log. The latest one's
 * message, service, and task stay.
 */
export function mergeErrorGroups(groups: ErrorGroup[]): ErrorGroup[] {
  const merged = new Map<string, ErrorGroup>();

  for (const group of groups) {
    const key = [group.class ?? '', group.class ? '' : group.message, group.file ?? '', group.level].join('\u0000');
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...group });
      continue;
    }

    const latest = (group.lastSeen ?? '') > (existing.lastSeen ?? '') ? group : existing;
    merged.set(key, {
      ...latest,
      count: existing.count + group.count,
      firstSeen: [existing.firstSeen, group.firstSeen].filter(Boolean).sort()[0],
      lastSeen: latest.lastSeen,
    });
  }

  return [...merged.values()].sort((a, b) => b.count - a.count);
}

/**
 * The groups of the query's rows, merged. `truncated` counts the rows: the
 * query returns at most `limit` of them, and merging can make fewer groups.
 */
export function summarizeErrors(rows: InsightsRow[], sources: LogSource[], limit: number) {
  const raw = rows.map((row) => toErrorGroup(row, sources)).filter((group) => group.count > 0);
  const groups = mergeErrorGroups(raw);

  return { groups, total: groups.reduce((sum, group) => sum + group.count, 0), truncated: rows.length >= limit };
}

const shortPath = (file: string | null) => file?.replace(/^\/var\/www\/html\//, '') ?? '-';
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function formatErrorGroups(groups: ErrorGroup[]): string[] {
  return groups.flatMap((group) => [
    `${String(group.count).padStart(6)}x ${group.level.padEnd(9)} ${group.class ?? '(no exception)'} at ${shortPath(group.file)}${group.thrownAt ? ` (thrown at ${shortPath(group.thrownAt)})` : ''} [${group.service ?? '?'}] first ${group.firstSeen ?? '?'}, last ${group.lastSeen ?? '?'}`,
    `        ${clip(group.message.replace(/\s+/g, ' '), 300)}`,
  ]);
}

export const logsErrorsCommand = new Command('logs:errors')
  .description('Summarise the Laravel and PHP errors of a window with CloudWatch Logs Insights: grouped, with counts and first and last seen. Exits 1 when there are any.')
  .argument('[service]', 'web, reverb, worker (every worker), a worker name, or another task in the cluster (default: all)')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'ECS cluster name or ARN (default: auto-detected from the stage)')
  .option('-r, --region <region>', APP_REGION_OPTION_HELP)
  .option('--since <duration>', 'How far back, e.g. 1h, 24h, 7d (default: 24h)')
  .option('--start <time>', 'Start of the window: an ISO 8601 time (UTC unless it has an offset) or a duration ago')
  .option('--end <time>', 'End of the window, exclusive (default: now)')
  .option('--limit <groups>', 'Most error groups to list', '50')
  .option('--json', 'Print one JSON document instead of text')
  .action(async (service: string | undefined, options: LogsErrorsOptions) => {
    try {
      const window = resolveTimeWindow(options, '24h');
      const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 1000);
      const stage = await resolveStageLogs(options);
      const sources = selectLogSources(stage.sources, service);

      info(`Errors of ${sources.map((source) => source.service).join(', ')} from ${formatWindow(window)} (Logs Insights)...`);

      const rows = await runInsightsQuery(stage.logs, sources.map((source) => source.logGroup), window, errorsQuery(limit));
      const { groups, total, truncated } = summarizeErrors(rows, sources, limit);

      if (options.json) {
        printJson({
          window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
          services: sources.map((source) => source.service),
          total,
          truncated,
          errors: groups,
        });
      } else if (groups.length === 0) {
        console.log(`No errors from ${formatWindow(window)}.`);
      } else {
        console.log(`${total} error${total === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'} from ${formatWindow(window)}${truncated ? ` (the top ${limit}; raise --limit for more)` : ''}:`);
        formatErrorGroups(groups).forEach((line) => console.log(line));
        console.log(`Full lines: npx sst-laravel logs --stage ${options.stage ?? '<stage>'} --no-follow --start ${new Date(window.start).toISOString()} --end ${new Date(window.end).toISOString()} --filter '?ERROR ?CRITICAL ?ALERT ?EMERGENCY ?"PHP Fatal"'`);
      }

      await exitAfterOutput(groups.length > 0 ? EXIT_ATTENTION : EXIT_OK);
    } catch (error) {
      await exitWithError(error, EXIT_ERROR);
    }
  });
