import { CloudWatchLogsClient, FilterLogEventsCommand, FilteredLogEvent } from '@aws-sdk/client-cloudwatch-logs';
import type { LogSource } from './log-sources.js';
import type { TimeWindow } from './time.js';

/** Drops ANSI color codes so the output reads cleanly in a terminal log or an agent transcript. */
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

export interface LogLine {
  /** Epoch milliseconds. */
  timestamp: number;
  service: string;
  container: string;
  /** The ECS task ID, the last part of the log stream name (`/service/<container>/<task>`). */
  task?: string;
  logGroup: string;
  logStream: string;
  eventId?: string;
  /** The line as the container wrote it, without color codes or the trailing line break. */
  message: string;
  /** The message, parsed, when it is a JSON object (JSON Laravel logs, sst-laravel events). */
  json?: Record<string, unknown>;
}

export const taskIdFromStream = (logStream: string): string | undefined => {
  const last = logStream.split('/').pop();
  return last && /^[0-9a-f]{32}$/.test(last) ? last : undefined;
};

/** Where an `sst_laravel` event starts in a line another process's output ran into. */
const EVENT_START = '{"sst_laravel":';

export function parseJsonMessage(message: string): Record<string, unknown> | undefined {
  let trimmed = message.trim();

  if (!trimmed.startsWith('{') && trimmed.includes(EVENT_START)) {
    trimmed = trimmed.slice(trimmed.indexOf(EVENT_START));
  }

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function toLogLine(event: FilteredLogEvent, source: LogSource): LogLine {
  const message = stripAnsi(event.message ?? '').replace(/\r?\n$/, '').replace(/\r$/, '');
  const logStream = event.logStreamName ?? '';

  return {
    timestamp: event.timestamp ?? 0,
    service: source.service,
    container: source.container,
    task: taskIdFromStream(logStream),
    logGroup: source.logGroup,
    logStream,
    eventId: event.eventId,
    message,
    json: parseJsonMessage(message),
  };
}

/**
 * The lines Laravel's text log format spreads a stack trace over:
 * `[stacktrace]`, the `#0 /path(12): ...` frames, `[previous exception]`,
 * and the closing `"}`. Each one arrives as its own log event.
 */
const CONTINUATION = /^(\[stacktrace\]|\[previous exception\]|#\d+ |"\}\s*$)/;

/**
 * Joins the stack trace lines of text logs to the entry they belong to, the
 * previous line of the same log stream, so a trace reads as one entry. JSON
 * logs already keep each entry on one line.
 */
export function joinStackTraces(lines: LogLine[]): LogLine[] {
  const joined: LogLine[] = [];
  const lastOfStream = new Map<string, LogLine>();

  for (const line of lines) {
    const key = `${line.logGroup}\u0000${line.logStream}`;
    const previous = lastOfStream.get(key);

    if (previous && !line.json && !previous.json && CONTINUATION.test(line.message)) {
      previous.message = `${previous.message}\n${line.message}`;
      continue;
    }

    const copy = { ...line };
    joined.push(copy);
    lastOfStream.set(key, copy);
  }

  return joined;
}

export interface FetchOptions {
  filterPattern?: string;
  /** Stop after this many lines of each log group. */
  limit: number;
}

export interface FetchResult {
  lines: LogLine[];
  /**
   * Set when a log group had more lines than the limit: the lines are
   * complete up to (not including) this time. Continue from it with
   * `--start`.
   */
  truncatedAt?: number;
}

/**
 * A log group's lines in the window, oldest first, up to the limit. Past
 * the limit, it reads on through the last line's millisecond, so the lines
 * are complete up to and including `completeThrough`, even when several
 * share that millisecond.
 */
async function fetchGroup(client: CloudWatchLogsClient, source: LogSource, window: TimeWindow, options: FetchOptions) {
  const lines: LogLine[] = [];
  let nextToken: string | undefined;
  const boundary = () => lines[options.limit - 1]?.timestamp;

  do {
    const response = await client.send(new FilterLogEventsCommand({
      logGroupName: source.logGroup,
      startTime: window.start,
      // FilterLogEvents includes the end time; the window doesn't.
      endTime: window.end - 1,
      filterPattern: options.filterPattern,
      nextToken,
    }));

    for (const event of response.events ?? []) {
      lines.push(toLogLine(event, source));
    }

    nextToken = response.nextToken;
  } while (nextToken && (lines.length < options.limit || lines[lines.length - 1].timestamp <= boundary()!));

  if (lines.length <= options.limit && !nextToken) {
    return { lines };
  }

  const completeThrough = boundary()!;
  return { lines: lines.filter((line) => line.timestamp <= completeThrough), completeThrough };
}

const byTime = (a: LogLine, b: LogLine) => a.timestamp - b.timestamp;

/**
 * The lines of every source in the window, oldest first. When a log group
 * has more than the limit, the result stops where that group's lines do,
 * so no group is missing lines another group shows.
 */
export async function fetchLogLines(
  client: CloudWatchLogsClient,
  sources: LogSource[],
  window: TimeWindow,
  options: FetchOptions,
): Promise<FetchResult> {
  const groups = await Promise.all(sources.map((source) => fetchGroup(client, source, window, options)));
  const bounds = groups.map((group) => group.completeThrough).filter((time): time is number => time !== undefined);
  const lines = groups.flatMap((group) => group.lines).sort(byTime);

  if (bounds.length === 0) {
    return { lines };
  }

  const truncatedAt = Math.min(...bounds) + 1;
  return { lines: lines.filter((line) => line.timestamp < truncatedAt), truncatedAt };
}

/**
 * How far back each poll of `followLogLines` reads again. CloudWatch can
 * take its time to show an event, so another task's line can turn up with
 * a time before lines already printed.
 */
export const FOLLOW_LOOKBACK_MS = 60000;

/**
 * Keeps printing new lines of every source until the process is stopped:
 * polls each log group every `intervalMs`, from `FOLLOW_LOOKBACK_MS` before
 * the newest time it has seen, and drops the events it already printed.
 */
export async function followLogLines(
  client: CloudWatchLogsClient,
  sources: LogSource[],
  start: number,
  options: {
    filterPattern?: string;
    intervalMs?: number;
    onLines: (lines: LogLine[]) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Stops after this many polls (tests). */
    polls?: number;
  },
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const newest = new Map(sources.map((source) => [source.logGroup, start]));
  // The events printed, by ID, with their time, for as long as a poll can return them again.
  const printed = new Map<string, Map<string, number>>(sources.map((source) => [source.logGroup, new Map<string, number>()]));

  for (let poll = 0; options.polls === undefined || poll < options.polls; poll++) {
    const batches = await Promise.all(sources.map(async (source) => {
      const from = Math.max(start, newest.get(source.logGroup)! - FOLLOW_LOOKBACK_MS);
      const result = await fetchGroup(client, source, { start: from, end: now() + 1 }, {
        filterPattern: options.filterPattern,
        limit: Number.MAX_SAFE_INTEGER,
      });
      const ids = printed.get(source.logGroup)!;
      const fresh = result.lines.filter((line) => !line.eventId || !ids.has(line.eventId));

      for (const line of fresh) {
        if (line.eventId) ids.set(line.eventId, line.timestamp);
      }

      const latest = result.lines.reduce((max, line) => Math.max(max, line.timestamp), newest.get(source.logGroup)!);
      newest.set(source.logGroup, latest);

      for (const [id, time] of ids) {
        if (time < latest - FOLLOW_LOOKBACK_MS) ids.delete(id);
      }

      return fresh;
    }));

    const lines = batches.flat().sort(byTime);

    if (lines.length > 0) {
      options.onLines(lines);
    }

    if (options.polls === undefined || poll + 1 < options.polls) {
      await sleep(options.intervalMs ?? 2000);
    }
  }
}

const LEVEL = /\.(DEBUG|INFO|NOTICE|WARNING|ERROR|CRITICAL|ALERT|EMERGENCY):/;

/** The Laravel level of a line: `level_name` of JSON logs, or the `env.LEVEL:` of text logs. */
export function lineLevel(line: LogLine): string | undefined {
  const level = line.json?.level_name;

  if (typeof level === 'string') {
    return level;
  }

  return line.json ? undefined : line.message.match(LEVEL)?.[1];
}

/** The deploy (task definition revision) that wrote the line, from the package's JSON log fields. */
export function lineRevision(line: LogLine): string | undefined {
  const extra = line.json?.extra as Record<string, unknown> | undefined;
  const revision = extra?.revision ?? line.json?.revision;
  return typeof revision === 'string' ? revision : undefined;
}

/** One line of `logs` text output: time, service, short task ID, message. */
export const formatLogLine = (line: LogLine): string =>
  `${new Date(line.timestamp).toISOString()} ${line.service} ${line.task ? line.task.slice(0, 8) : '-'} ${line.message}`;

/** One line of `logs --json` output (JSON Lines). */
export const logLineJson = (line: LogLine) => ({
  timestamp: new Date(line.timestamp).toISOString(),
  service: line.service,
  container: line.container,
  task: line.task ?? null,
  revision: lineRevision(line) ?? null,
  level: lineLevel(line) ?? null,
  message: line.message,
  ...(line.json ? { json: line.json } : {}),
  logGroup: line.logGroup,
  logStream: line.logStream,
});
