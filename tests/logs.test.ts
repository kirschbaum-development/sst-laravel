import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTasksCommand, ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { shouldFollow } from '../bin/commands/logs';
import { toErrorGroup } from '../bin/commands/logs-errors';
import { Command } from 'commander';
import { queueStatusCommand } from '../bin/commands/queue-status';
import { CliError, exitWithErrorOnUsage } from '../bin/utils/cli';
import { findTask } from '../bin/utils/ecs';
import { fetchLogLines, followLogLines, joinStackTraces, LogLine, logLineJson, parseJsonMessage } from '../bin/utils/log-events';
import { windowQuery } from '../bin/utils/insights';
import { describeLogGroup, LogSource, selectLogSources } from '../bin/utils/log-sources';
import { parseTime, resolveTimeWindow } from '../bin/utils/time';
import { MONOLOG_JSON_FORMATTER, PACKAGE_JSON_FORMATTER, stderrLogFormatter } from '../src/log-format';

const NOW = Date.parse('2026-10-19T12:00:00Z');

describe('time windows', () => {
  it('reads ISO times without an offset as UTC, and durations back from now', () => {
    expect(parseTime('2026-10-18', NOW)).toBe(Date.parse('2026-10-18T00:00:00Z'));
    expect(parseTime('2026-10-18T06:30', NOW)).toBe(Date.parse('2026-10-18T06:30:00Z'));
    expect(parseTime('2026-10-18T06:30:00+02:00', NOW)).toBe(Date.parse('2026-10-18T04:30:00Z'));
    expect(parseTime('90m', NOW)).toBe(NOW - 90 * 60 * 1000);
  });

  it('makes exact daily windows from --start and --end', () => {
    expect(resolveTimeWindow({ start: '2026-10-18', end: '2026-10-19' }, '24h', NOW)).toEqual({
      start: Date.parse('2026-10-18T00:00:00Z'),
      end: Date.parse('2026-10-19T00:00:00Z'),
    });
  });

  it('counts --since back from --end', () => {
    expect(resolveTimeWindow({ since: '6h', end: '2026-10-19T00:00:00Z' }, '24h', NOW).start).toBe(Date.parse('2026-10-18T18:00:00Z'));
  });

  it('rejects ambiguous and empty windows as usage errors', () => {
    const usage = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof CliError ? error.exitCode : 'not a CliError';
      }
      return 'no error';
    };

    expect(usage(() => resolveTimeWindow({ since: '1h', start: '2026-10-18' }, '24h', NOW))).toBe(2);
    expect(usage(() => resolveTimeWindow({ start: '2026-10-19', end: '2026-10-18' }, '24h', NOW))).toBe(2);
    expect(usage(() => resolveTimeWindow({ since: 'yesterday' }, '24h', NOW))).toBe(2);
    expect(usage(() => parseTime('18/10/2026', NOW))).toBe(2);
  });
});

describe('logs follow default', () => {
  it('streams only in a terminal, and never for a closed window', () => {
    expect(shouldFollow({}, true)).toBe(true);
    expect(shouldFollow({}, false)).toBe(false);
    expect(shouldFollow({ end: '2026-10-19' }, true)).toBe(false);
    expect(shouldFollow({ follow: true }, false)).toBe(true);
    expect(shouldFollow({ follow: false }, true)).toBe(false);
  });
});

const CLUSTER = 'app-production-AppClusterCluster-abcdef';
const group = (resource: string, container: string) => `/sst/cluster/${CLUSTER}/${resource}/${container}`;

describe('log groups of the cluster', () => {
  it('tells the services, workers, and task runners apart, and leaves the ECS events out', () => {
    expect(describeLogGroup(group('app-production-AppWeb-x', 'App-Web'), CLUSTER, 'App')).toMatchObject({ kind: 'web', service: 'web' });
    expect(describeLogGroup(group('app-production-AppReverb-x', 'App-Reverb'), CLUSTER, 'App')).toMatchObject({ kind: 'reverb', service: 'reverb' });
    expect(describeLogGroup(group('app-production-Appqueue-x', 'App-queue'), CLUSTER, 'App')).toMatchObject({ kind: 'worker', service: 'queue' });
    expect(describeLogGroup(group('app-production-Migrator-x', 'Migrator'), CLUSTER, 'App')).toMatchObject({ kind: 'task', service: 'Migrator' });
    expect(describeLogGroup(`/sst/cluster/${CLUSTER}/sst-laravel/ecs-events`, CLUSTER, 'App')).toBeUndefined();
    expect(describeLogGroup(`/sst/cluster/other-cluster/x/App-Web`, CLUSTER, 'App')).toBeUndefined();
  });

  const sources = [
    describeLogGroup(group('w', 'App-Web'), CLUSTER, 'App')!,
    describeLogGroup(group('q', 'App-queue'), CLUSTER, 'App')!,
    describeLogGroup(group('m', 'App-mail'), CLUSTER, 'App')!,
    describeLogGroup(group('t', 'Migrator'), CLUSTER, 'App')!,
  ];

  it('selects every worker for `worker`, one by its name, and all without a name', () => {
    expect(selectLogSources(sources, 'worker').map((source) => source.service)).toEqual(['queue', 'mail']);
    expect(selectLogSources(sources, 'MAIL').map((source) => source.service)).toEqual(['mail']);
    expect(selectLogSources(sources, 'migrator').map((source) => source.kind)).toEqual(['task']);
    expect(selectLogSources(sources)).toHaveLength(4);
  });

  it('names the services with logs when the service is unknown', () => {
    expect(() => selectLogSources(sources, 'reverb')).toThrow('Services with logs: web, queue, mail, Migrator.');
  });
});

const line = (overrides: Partial<LogLine>): LogLine => ({
  timestamp: NOW,
  service: 'web',
  container: 'App-Web',
  logGroup: 'g',
  logStream: '/service/App-Web/0123456789abcdef0123456789abcdef',
  message: '',
  ...overrides,
});

describe('stack traces of text logs', () => {
  it('joins each trace to the entry of its own stream, even when streams interleave', () => {
    const a = '/service/App-Web/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = '/service/App-Web/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const joined = joinStackTraces([
      line({ logStream: a, message: '[2026-10-19 12:00:00] production.ERROR: boom {"exception":"[object] (RuntimeException(code: 0): boom at /var/www/html/app/A.php:3)' }),
      line({ logStream: b, message: '[2026-10-19 12:00:00] production.INFO: hello' }),
      line({ logStream: a, message: '[stacktrace]' }),
      line({ logStream: a, message: '#0 /var/www/html/app/B.php(9): A->run()' }),
      line({ logStream: b, message: '#1 {main}' }),
      line({ logStream: a, message: '"} ' }),
    ]);

    expect(joined.map((entry) => entry.message.split('\n').length)).toEqual([4, 2]);
    expect(joined[0].message).toContain('#0 /var/www/html/app/B.php(9)');
  });

  it('finds an event in a line that another output ran into, but not JSON at the end of a text log', () => {
    expect(parseJsonMessage('  Running [php artisan app:report] {"sst_laravel":"schedule_finished","exit_code":1}')).toEqual({ sst_laravel: 'schedule_finished', exit_code: 1 });
    expect(parseJsonMessage('[2026-10-19 12:00:00] production.ERROR: boom {"userId":1}')).toBeUndefined();
  });

  it('leaves JSON lines alone', () => {
    const json = { level_name: 'ERROR', message: 'x' };
    expect(joinStackTraces([line({ message: JSON.stringify(json), json }), line({ message: '#0 not a trace' })])).toHaveLength(2);
  });
});

describe('logs --json lines', () => {
  it('keep the service, task, deploy, and level of each line', () => {
    const json = { message: 'boom', level_name: 'ERROR', extra: { service: 'web', ecs_task: 'x', revision: 'App-Web-Task:42' } };
    expect(logLineJson(line({ message: JSON.stringify(json), json, task: '0123456789abcdef0123456789abcdef' }))).toMatchObject({
      service: 'web',
      task: '0123456789abcdef0123456789abcdef',
      revision: 'App-Web-Task:42',
      level: 'ERROR',
    });
    expect(logLineJson(line({ message: '[2026-10-19 12:00:00] production.WARNING: slow' })).level).toBe('WARNING');
  });
});

describe('fetchLogLines', () => {
  const sourceA: LogSource = { logGroup: 'a', service: 'web', kind: 'web', container: 'App-Web' };
  const sourceB: LogSource = { logGroup: 'b', service: 'queue', kind: 'worker', container: 'App-queue' };

  it('stops every group where the first truncated group stops, so none is missing lines another shows', async () => {
    // Group a has 5 lines a minute apart, more than the limit of 3; group b has one line after them.
    const pages: Record<string, Array<{ timestamp: number; message: string }>> = {
      a: [0, 1, 2, 3, 4].map((minute) => ({ timestamp: NOW + minute * 60000, message: `a${minute}` })),
      b: [{ timestamp: NOW + 30000, message: 'b0' }, { timestamp: NOW + 10 * 60000, message: 'b1' }],
    };
    const send = vi.fn(async (command: FilterLogEventsCommand) => {
      const events = pages[command.input.logGroupName!];
      const offset = Number(command.input.nextToken ?? 0);
      return { events: events.slice(offset, offset + 2), nextToken: offset + 2 < events.length ? String(offset + 2) : undefined };
    });

    const result = await fetchLogLines({ send } as unknown as CloudWatchLogsClient, [sourceA, sourceB], { start: NOW, end: NOW + 3600000 }, { limit: 3 });

    // a's third line (a2, at minute 2) is where a stops: lines up to it are complete.
    expect(result.lines.map((entry) => entry.message)).toEqual(['a0', 'b0', 'a1', 'a2']);
    expect(result.truncatedAt).toBe(NOW + 2 * 60000 + 1);
    expect(send.mock.calls[0][0].input.endTime).toBe(NOW + 3600000 - 1);
  });

  it('reads on through the millisecond it stops at, so continuing from truncatedAt skips nothing', async () => {
    const events = [NOW + 5, NOW + 5, NOW + 5, NOW + 9].map((timestamp, index) => ({ timestamp, message: `a${index}` }));
    const send = vi.fn(async (command: FilterLogEventsCommand) => {
      const from = command.input.startTime!;
      const matching = events.filter((event) => event.timestamp >= from);
      const offset = Number(command.input.nextToken ?? 0);
      return { events: matching.slice(offset, offset + 2), nextToken: offset + 2 < matching.length ? String(offset + 2) : undefined };
    });
    const client = { send } as unknown as CloudWatchLogsClient;

    const first = await fetchLogLines(client, [sourceA], { start: NOW, end: NOW + 60000 }, { limit: 2 });
    const rest = await fetchLogLines(client, [sourceA], { start: first.truncatedAt!, end: NOW + 60000 }, { limit: 2 });

    expect(first.lines.map((entry) => entry.message)).toEqual(['a0', 'a1', 'a2']);
    expect([...first.lines, ...rest.lines].map((entry) => entry.message)).toEqual(['a0', 'a1', 'a2', 'a3']);
  });
});

describe('followLogLines', () => {
  it('prints a line another task logged with an earlier time, when it shows up a poll later, once', async () => {
    const source: LogSource = { logGroup: 'a', service: 'web', kind: 'web', container: 'App-Web' };
    const visible = [[{ eventId: '1', timestamp: NOW + 1000, message: 'task one' }], [{ eventId: '2', timestamp: NOW + 400, message: 'task two, late' }]];
    let poll = 0;
    const send = vi.fn(async (command: FilterLogEventsCommand) => {
      const events = visible.slice(0, poll + 1).flat().filter((event) => event.timestamp >= command.input.startTime!);
      return { events };
    });
    const printed: string[] = [];

    await followLogLines({ send } as unknown as CloudWatchLogsClient, [source], NOW, {
      onLines: (lines) => printed.push(...lines.map((line) => line.message)),
      sleep: async () => { poll++; },
      now: () => NOW + 2000,
      polls: 3,
    });

    expect(printed).toEqual(['task one', 'task two, late']);
  });
});

describe('Logs Insights windows', () => {
  it('keeps a query to the milliseconds of the window, which StartQuery only takes in seconds', () => {
    const query = windowQuery('stats count(*)', { start: Date.parse('2026-10-19T11:00:00.500Z'), end: Date.parse('2026-10-19T12:00:00.250Z') });
    expect(query).toBe(`filter toMillis(@timestamp) >= ${Date.parse('2026-10-19T11:00:00.500Z')} and toMillis(@timestamp) < ${Date.parse('2026-10-19T12:00:00.250Z')}\n| stats count(*)`);
  });
});

describe('findTask without a terminal', () => {
  const tasks = [{ taskArn: 'arn:aws:ecs:us-east-1:1:task/c/1111', group: 'service:App-Web', containers: [{ name: 'App-Web' }], lastStatus: 'RUNNING' }];
  const ecs = {
    send: async (command: unknown) => (command instanceof ListTasksCommand ? { taskArns: ['t'] } : command instanceof DescribeTasksCommand ? { tasks } : {}),
  } as unknown as ECSClient;

  it('fails with the running services instead of prompting', async () => {
    await expect(findTask(ecs, { clusterArn: 'c', component: 'App' }, 'worker')).rejects.toThrow('No running task of "worker". Running: App-Web.');
    await expect(findTask(ecs, { clusterArn: 'c', component: 'App' })).rejects.toBeInstanceOf(CliError);
  });

  it('still finds the task of a named service', async () => {
    expect((await findTask(ecs, { clusterArn: 'c', component: 'App' }, 'web')).taskArn).toBe(tasks[0].taskArn);
  });
});

describe('logs:errors groups', () => {
  it('names the service and task of the latest error from its log group and stream', () => {
    const sources: LogSource[] = [{ logGroup: group('q', 'App-queue'), service: 'queue', kind: 'worker', container: 'App-queue' }];

    expect(toErrorGroup({
      errorKey: 'RuntimeException',
      errorFile: '/var/www/html/app/Jobs/Send.php:12',
      errorLevel: 'ERROR',
      count: '7',
      firstSeen: '2026-10-19 01:00:00.000',
      lastSeen: '2026-10-19 11:00:00.000',
      class: 'RuntimeException',
      lastMessage: 'boom',
      lastLog: `123456789012:${group('q', 'App-queue')}`,
      lastStream: '/service/App-queue/0123456789abcdef0123456789abcdef',
    }, sources)).toEqual({
      class: 'RuntimeException',
      message: 'boom',
      file: '/var/www/html/app/Jobs/Send.php:12',
      level: 'ERROR',
      count: 7,
      firstSeen: '2026-10-19T01:00:00.000Z',
      lastSeen: '2026-10-19T11:00:00.000Z',
      service: 'queue',
      task: '0123456789abcdef0123456789abcdef',
    });
  });
});

describe('stderrLogFormatter', () => {
  it('names the package formatter only when Composer installed it', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-format-'));

    expect(stderrLogFormatter(app)).toBe(MONOLOG_JSON_FORMATTER);
    fs.mkdirSync(path.join(app, 'vendor/kirschbaum-development/sst-laravel/laravel/Logging'), { recursive: true });
    fs.writeFileSync(path.join(app, 'vendor/kirschbaum-development/sst-laravel/laravel/Logging/JsonFormatter.php'), '<?php');
    expect(stderrLogFormatter(app)).toBe(PACKAGE_JSON_FORMATTER);
    expect(stderrLogFormatter(app, 'text')).toBeUndefined();
    expect(() => stderrLogFormatter(app, 'yaml')).toThrow('config.logFormat must be "json" or "text"');
  });
});

describe('usage errors', () => {
  it('exit 2, so a caller can tell a bad invocation from a check that needs attention', () => {
    const exitCode = (args: string[]) => {
      const program = new Command().name('sst-laravel').version('1.0.0').addCommand(queueStatusCommand);
      exitWithErrorOnUsage(program);
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
      const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];

      try {
        program.parse(['node', 'sst-laravel', ...args]);
        return undefined;
      } catch (error) {
        return (error as Error).message;
      } finally {
        [exit, ...quiet].forEach((spy) => spy.mockRestore());
      }
    };

    expect(exitCode(['queue:status', '--max-size'])).toBe('exit 2');
    expect(exitCode(['queue:status', '--bogus'])).toBe('exit 2');
    expect(exitCode(['queue:status', '--help'])).toBe('exit 0');
    expect(exitCode(['--version'])).toBe('exit 0');
  });
});
