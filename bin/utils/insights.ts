import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CliError } from './cli.js';
import type { TimeWindow } from './time.js';

/** Logs Insights queries at most this many log groups at once. */
export const MAX_QUERY_LOG_GROUPS = 50;

export type InsightsRow = Record<string, string>;

export interface InsightsOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The query, for the events of the window only (its end is exclusive). */
export const windowQuery = (query: string, window: TimeWindow): string =>
  `filter toMillis(@timestamp) >= ${window.start} and toMillis(@timestamp) < ${window.end}\n| ${query.trim()}`;

/**
 * Runs a Logs Insights query over the log groups and returns its rows, each
 * as an object of field to value (without `@ptr`).
 */
export async function runInsightsQuery(
  client: CloudWatchLogsClient,
  logGroups: string[],
  window: TimeWindow,
  query: string,
  options: InsightsOptions = {},
): Promise<InsightsRow[]> {
  if (logGroups.length === 0) {
    return [];
  }

  if (logGroups.length > MAX_QUERY_LOG_GROUPS) {
    throw new CliError(`Logs Insights reads at most ${MAX_QUERY_LOG_GROUPS} log groups at once, and this matches ${logGroups.length}. Name a service to narrow it.`, 2);
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60 * 1000);
  const { queryId } = await client.send(new StartQueryCommand({
    logGroupNames: logGroups,
    // Insights takes whole seconds: the seconds around the window, then the
    // query's first filter keeps it to the millisecond.
    startTime: Math.floor(window.start / 1000),
    endTime: Math.ceil(window.end / 1000),
    queryString: windowQuery(query, window),
  }));

  for (;;) {
    const response = await client.send(new GetQueryResultsCommand({ queryId }));

    switch (response.status) {
      case 'Complete':
        return (response.results ?? []).map((fields) =>
          Object.fromEntries(
            fields.filter((field) => field.field && field.field !== '@ptr').map((field) => [field.field!, field.value ?? '']),
          ),
        );
      case 'Failed':
      case 'Cancelled':
      case 'Timeout':
        throw new CliError(`The Logs Insights query ended with status ${response.status}.`, 2);
    }

    if (Date.now() > deadline) {
      await client.send(new StopQueryCommand({ queryId })).catch(() => undefined);
      throw new CliError('The Logs Insights query did not finish in time. Try a shorter window.', 2);
    }

    await sleep(options.pollMs ?? 1000);
  }
}

/**
 * Insights times (`2026-10-19 06:00:00.000`, UTC) as ISO 8601. Anything
 * else is returned as is.
 */
export const insightsTimeToIso = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return match ? new Date(`${match[1]}T${match[2]}Z`).toISOString() : value;
};

/** `account:/sst/cluster/...` (`@log` in Insights) without the account. */
export const insightsLogGroup = (value: string | undefined): string | undefined =>
  value?.replace(/^\d{12}:/, '');
