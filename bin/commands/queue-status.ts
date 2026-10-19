import { Command } from 'commander';
import { APP_REGION_OPTION_HELP } from '../utils/aws.js';
import { CliError, EXIT_ATTENTION, EXIT_ERROR, EXIT_OK, exitAfterOutput, exitWithError, info, printJson } from '../utils/cli.js';
import { InsightsRow, insightsTimeToIso, runInsightsQuery } from '../utils/insights.js';
import { selectLogSources } from '../utils/log-sources.js';
import { resolveStageLogs } from '../utils/stage-logs.js';
import { formatWindow, resolveTimeWindow, TimeWindow } from '../utils/time.js';

interface QueueStatusOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  since?: string;
  start?: string;
  end?: string;
  maxSize?: string;
  samples?: boolean;
  json?: boolean;
}

/**
 * The queries over the `sst_laravel` events the Laravel package writes in
 * the containers (`kirschbaum-development/sst-laravel` in composer.json):
 * failed jobs, a queue size sample each minute from the scheduler, and every
 * scheduled task that finished, failed, or was skipped.
 */
export const QUEUE_QUERIES = {
  failedJobs: `filter sst_laravel = "job_failed"
| stats count(*) as failures, min(@timestamp) as firstSeen, max(@timestamp) as lastSeen, latest(exception) as exception, latest(message) as lastMessage by job, connection, queue
| sort failures desc
| limit 100`,
  queues: `filter sst_laravel = "queue_size"
| stats latest(size) as size, max(size) as maxSize, latest(error) as error, max(@timestamp) as sampledAt by connection, queue
| limit 100`,
  failedTotal: `filter sst_laravel = "failed_jobs_total"
| stats latest(failed_jobs) as total, max(@timestamp) as sampledAt`,
  scheduleFinished: `filter sst_laravel = "schedule_finished"
| stats count(*) as runs, max(@timestamp) as lastFinished, latest(exit_code) as lastExitCode, latest(runtime) as lastRuntime, latest(expression) as expression by task
| limit 200`,
  scheduleFailed: `filter sst_laravel = "schedule_failed"
| stats count(*) as failures, max(@timestamp) as lastFailed, latest(message) as lastError by task
| limit 200`,
  // A command that exits non-zero only finishes with its exit code on Laravel 10 and 11, and in the background.
  scheduleExitFailed: `filter sst_laravel = "schedule_finished" and exit_code != 0
| stats count(*) as failures, max(@timestamp) as lastFailed by task
| limit 200`,
  scheduleSkipped: `filter sst_laravel = "schedule_skipped"
| stats count(*) as skips, max(@timestamp) as lastSkipped by task
| limit 200`,
};

export interface ScheduledTaskStatus {
  task: string;
  expression: string | null;
  runs: number;
  failures: number;
  skips: number;
  lastFinished: string | null;
  lastExitCode: number | null;
  lastFailed: string | null;
  lastError: string | null;
  lastSkipped: string | null;
  /** `ok`, `failed` (the last run failed), or `skipped` (it only got skipped). */
  lastStatus: 'ok' | 'failed' | 'skipped';
}

const numberOrNull = (value?: string) => (value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const iso = (value?: string) => insightsTimeToIso(value) ?? null;

const latestTime = (...times: Array<string | null>) =>
  times.filter((time): time is string => Boolean(time)).sort().pop() ?? null;

/**
 * Each scheduled task's runs in the window. A run failed when it threw
 * (`schedule_failed`) or exited non-zero (`schedule_finished` with its exit
 * code); the package logs one or the other for a run, never both. A run
 * that threw didn't finish, so the runs are the finished ones and those.
 */
export function combineSchedule(finished: InsightsRow[], failed: InsightsRow[], skipped: InsightsRow[], exitFailed: InsightsRow[] = []): ScheduledTaskStatus[] {
  const tasks = new Set([...finished, ...failed, ...skipped, ...exitFailed].filter((row) => row.runs || row.failures || row.skips).map((row) => row.task).filter(Boolean));

  return [...tasks].sort().map((task) => {
    const done = finished.find((row) => row.task === task);
    const fail = failed.find((row) => row.task === task);
    const exitFail = exitFailed.find((row) => row.task === task);
    const skip = skipped.find((row) => row.task === task);
    const lastFinished = iso(done?.lastFinished);
    const lastFailed = latestTime(iso(fail?.lastFailed), iso(exitFail?.lastFailed));
    const lastExitCode = numberOrNull(done?.lastExitCode);
    const failedLast = Boolean(lastFailed && (!lastFinished || lastFailed >= lastFinished)) || (lastExitCode !== null && lastExitCode !== 0);

    return {
      task,
      expression: done?.expression || null,
      runs: Number(done?.runs ?? 0) + Number(fail?.failures ?? 0),
      failures: Number(fail?.failures ?? 0) + Number(exitFail?.failures ?? 0),
      skips: Number(skip?.skips ?? 0),
      lastFinished,
      lastExitCode,
      lastFailed,
      lastError: fail?.lastError || null,
      lastSkipped: iso(skip?.lastSkipped),
      lastStatus: failedLast ? 'failed' : done || fail ? 'ok' : 'skipped',
    };
  });
}

export interface QueueReport {
  window: { start: string; end: string };
  failedJobs: Array<{ job: string; connection: string | null; queue: string | null; failures: number; firstSeen: string | null; lastSeen: string | null; exception: string | null; lastMessage: string | null }>;
  queues: Array<{ connection: string; queue: string; size: number | null; maxSize: number | null; sampledAt: string | null; error: string | null }>;
  failedJobsTotal: { total: number | null; sampledAt: string | null } | null;
  schedule: ScheduledTaskStatus[];
  /** True when the window has none of the package's events: then the check could not run, unless the app takes no samples. */
  noEvents: boolean;
  attention: string[];
}

/** The scheduler samples each queue every minute; this much silence means it stopped. */
export const SAMPLE_STALE_MS = 10 * 60 * 1000;

export function buildQueueReport(
  rows: Record<keyof typeof QUEUE_QUERIES, InsightsRow[]>,
  window: TimeWindow,
  options: { maxSize?: number; now?: number; samples?: boolean } = {},
): QueueReport {
  // Rows without their key fields are not results of these queries.
  const failedJobs = rows.failedJobs.filter((row) => Number(row.failures) > 0).map((row) => ({
    job: row.job || 'unknown',
    connection: row.connection || null,
    queue: row.queue || null,
    failures: Number(row.failures ?? 0),
    firstSeen: iso(row.firstSeen),
    lastSeen: iso(row.lastSeen),
    exception: row.exception || null,
    lastMessage: row.lastMessage || null,
  }));
  const queues = rows.queues.filter((row) => row.sampledAt).map((row) => ({
    connection: row.connection || 'default',
    queue: row.queue || 'default',
    size: numberOrNull(row.size),
    maxSize: numberOrNull(row.maxSize),
    sampledAt: iso(row.sampledAt),
    error: row.error || null,
  }));
  const total = rows.failedTotal.find((row) => row.sampledAt);
  const schedule = combineSchedule(rows.scheduleFinished, rows.scheduleFailed, rows.scheduleSkipped, rows.scheduleExitFailed);
  const attention: string[] = [];

  for (const job of failedJobs) {
    attention.push(`${job.job} failed ${job.failures} time${job.failures === 1 ? '' : 's'} on ${job.connection ?? '?'}/${job.queue ?? '?'}, last ${job.lastSeen}: ${job.exception ?? ''} ${job.lastMessage ?? ''}`.trim());
  }

  for (const task of schedule.filter((candidate) => candidate.lastStatus === 'failed')) {
    attention.push(`scheduled ${task.task} failed its last run (${task.lastFailed ?? task.lastFinished})${task.lastError ? `: ${task.lastError}` : task.lastExitCode ? ` with exit code ${task.lastExitCode}` : ''}`);
  }

  for (const queue of queues) {
    if (queue.error) {
      attention.push(`${queue.connection}/${queue.queue}: could not read its size: ${queue.error}`);
    } else if (options.maxSize !== undefined && (queue.size ?? 0) > options.maxSize) {
      attention.push(`${queue.connection}/${queue.queue} has ${queue.size} jobs waiting (more than ${options.maxSize})`);
    }
  }

  const noEvents = failedJobs.length === 0 && queues.length === 0 && !total && schedule.length === 0;

  // The scheduler samples each queue every minute until the window ends.
  if (options.samples !== false && !noEvents) {
    const end = Math.min(window.end, options.now ?? Date.now());

    if (queues.length === 0) {
      attention.push('no queue size samples in the window: the scheduler that takes them every minute is not running. Pass --no-samples if the app runs no scheduler.');
    }

    for (const queue of queues) {
      if (queue.sampledAt && end - Date.parse(queue.sampledAt) > SAMPLE_STALE_MS) {
        attention.push(`${queue.connection}/${queue.queue}: no size sample since ${queue.sampledAt}: the scheduler stopped, or no longer samples it`);
      }
    }
  }

  return {
    window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
    failedJobs,
    queues,
    failedJobsTotal: total ? { total: numberOrNull(total.total), sampledAt: iso(total.sampledAt) } : null,
    schedule,
    noEvents,
    attention,
  };
}

export function formatQueueReport(report: QueueReport): string[] {
  const lines = [`Queues and scheduled tasks ${report.window.start} to ${report.window.end}:`];

  for (const queue of report.queues) {
    lines.push(`[${queue.error ? 'FIX' : 'ok'}] queue ${queue.connection}/${queue.queue}: ${queue.error ? `error: ${queue.error}` : `${queue.size} waiting (max ${queue.maxSize} in the window)`}, sampled ${queue.sampledAt}`);
  }

  if (report.failedJobsTotal) {
    lines.push(`[..] failed_jobs table: ${report.failedJobsTotal.total} (sampled ${report.failedJobsTotal.sampledAt})`);
  }

  for (const job of report.failedJobs) {
    lines.push(`[FIX] failed job ${job.job} (${job.connection}/${job.queue}): ${job.failures}x, first ${job.firstSeen}, last ${job.lastSeen}: ${job.exception ?? ''} ${job.lastMessage ?? ''}`.trimEnd());
  }

  if (report.failedJobs.length === 0) {
    lines.push('[ok] failed jobs: none in the window');
  }

  for (const task of report.schedule) {
    const mark = task.lastStatus === 'failed' ? 'FIX' : task.lastStatus === 'skipped' ? '..' : 'ok';
    lines.push(`[${mark}] schedule ${task.task}${task.expression ? ` (${task.expression})` : ''}: ${task.runs} run${task.runs === 1 ? '' : 's'}, ${task.failures} failed, ${task.skips} skipped; last finished ${task.lastFinished ?? 'never'}${task.lastExitCode !== null ? ` (exit ${task.lastExitCode})` : ''}${task.lastFailed ? `, last failed ${task.lastFailed}` : ''}`);
  }

  if (report.noEvents) {
    lines.push('[--] no queue or schedule events in the window. They come from the Laravel package: `composer require kirschbaum-development/sst-laravel`, and deploy with this version. Queue sizes need the scheduler running (`scheduler: true`); pass --no-samples if the app runs none.');
  }

  return lines;
}

export const queueStatusCommand = new Command('queue:status')
  .description('Report failed jobs, queue sizes, and when each scheduled task last ran, from the events the Laravel package logs. Read-only, no shell in the container. Exits 1 when something needs attention.')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'ECS cluster name or ARN (default: auto-detected from the stage)')
  .option('-r, --region <region>', APP_REGION_OPTION_HELP)
  .option('--since <duration>', 'How far back, e.g. 1h, 24h, 7d (default: 24h)')
  .option('--start <time>', 'Start of the window: an ISO 8601 time (UTC unless it has an offset) or a duration ago')
  .option('--end <time>', 'End of the window, exclusive (default: now)')
  .option('--max-size <jobs>', 'Needs attention when a queue has more jobs waiting than this')
  .option('--no-samples', 'The app runs no scheduler: expect no queue size samples, and exit 0 without events')
  .option('--json', 'Print one JSON document instead of text')
  .action(async (options: QueueStatusOptions) => {
    try {
      const window = resolveTimeWindow(options, '24h');
      const maxSize = options.maxSize === undefined ? undefined : Number(options.maxSize);

      if (maxSize !== undefined && (!Number.isFinite(maxSize) || maxSize < 0)) {
        throw new CliError('--max-size must be a number of jobs.', EXIT_ERROR);
      }

      const stage = await resolveStageLogs(options);
      const groups = selectLogSources(stage.sources).map((source) => source.logGroup);

      info(`Queue and schedule events from ${formatWindow(window)} (Logs Insights)...`);

      const entries = await Promise.all(
        Object.entries(QUEUE_QUERIES).map(async ([key, query]) => [key, await runInsightsQuery(stage.logs, groups, window, query)] as const),
      );
      const report = buildQueueReport(Object.fromEntries(entries) as Record<keyof typeof QUEUE_QUERIES, InsightsRow[]>, window, { maxSize, samples: options.samples });

      if (options.json) {
        printJson(report);
      } else {
        formatQueueReport(report).forEach((line) => console.log(line));
        report.attention.forEach((line) => console.log(`Needs attention: ${line}`));
      }

      // Without any event, nothing says the package and the scheduler are there to log them.
      if (report.noEvents && options.samples !== false) {
        info('Could not check: no events from the Laravel package in the window.');
        await exitAfterOutput(EXIT_ERROR);
      }

      await exitAfterOutput(report.attention.length > 0 ? EXIT_ATTENTION : EXIT_OK);
    } catch (error) {
      await exitWithError(error, EXIT_ERROR);
    }
  });
