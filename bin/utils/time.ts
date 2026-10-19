import { CliError } from './cli.js';

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** `30s`, `5m`, `1h`, `2d`, or `1w` in milliseconds, or undefined when it isn't one. */
export function parseDuration(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)\s*([smhdw])$/i);
  return match ? Number(match[1]) * UNITS[match[2].toLowerCase()] : undefined;
}

/**
 * A point in time: an ISO 8601 date or date-time, read as UTC when it has no
 * offset (`2026-10-18` is midnight UTC), or a duration before `now`.
 */
export function parseTime(value: string, now: number): number {
  const duration = parseDuration(value);

  if (duration !== undefined) {
    return now - duration;
  }

  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(trimmed);

  if (iso) {
    const normalized = trimmed.replace(' ', 'T');
    const time = Date.parse(iso[1] ? normalized : normalized.length === 10 ? `${normalized}T00:00:00Z` : `${normalized}Z`);

    if (!Number.isNaN(time)) {
      return time;
    }
  }

  throw new CliError(`Invalid time "${value}". Use a duration (30s, 5m, 1h, 2d, 1w) or an ISO 8601 time (2026-10-18, 2026-10-18T06:00:00Z).`, 2);
}

export interface TimeWindow {
  /** Epoch milliseconds, inclusive. */
  start: number;
  /** Epoch milliseconds, exclusive. */
  end: number;
}

export interface TimeWindowOptions {
  since?: string;
  start?: string;
  end?: string;
}

/**
 * The window of `--since`, or of `--start` and `--end`. `--end` defaults to
 * now. Without either start option, the window is the `fallbackSince` before
 * the end.
 */
export function resolveTimeWindow(options: TimeWindowOptions, fallbackSince: string, now: number = Date.now()): TimeWindow {
  if (options.since && options.start) {
    throw new CliError('Pass --since or --start, not both.', 2);
  }

  const end = options.end ? parseTime(options.end, now) : now;
  let start: number;

  if (options.start) {
    start = parseTime(options.start, now);
  } else {
    const since = options.since ?? fallbackSince;
    const duration = parseDuration(since);

    if (duration === undefined) {
      throw new CliError(`Invalid --since "${since}". Use a duration such as 30m, 24h, or 7d; for a fixed time, use --start.`, 2);
    }

    start = end - duration;
  }

  if (start >= end) {
    throw new CliError(`The window is empty: the start (${new Date(start).toISOString()}) is not before the end (${new Date(end).toISOString()}).`, 2);
  }

  return { start, end };
}

export const formatWindow = (window: TimeWindow) =>
  `${new Date(window.start).toISOString()} to ${new Date(window.end).toISOString()}`;
