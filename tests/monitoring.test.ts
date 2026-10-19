import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStageTargets } from '../bin/commands/status';
import { buildQueueReport, combineSchedule, QUEUE_QUERIES } from '../bin/commands/queue-status';
import { saveDeploymentTargets } from '../bin/utils/deployment-targets';
import { classifyStoppedTask, ECS_EVENTS_LIMIT, parseEcsEvent, PROCESS_EXITS_LIMIT, stoppedTasksFromEvents, toProcessExit } from '../bin/utils/ecs-history';
import { buildHistoryReport, historyAttention } from '../bin/utils/history-report';
import { ECS_EVENT_RECORDER_SOURCE, serviceEventPattern } from '../src/ecs-events';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const window = { start: NOW - 24 * 3600000, end: NOW };

describe('classifyStoppedTask', () => {
  it('counts deployments and scale-in as expected, whatever the exit code', () => {
    expect(classifyStoppedTask({
      group: 'service:App-Web',
      stopCode: 'ServiceSchedulerInitiated',
      stoppedReason: 'Scaling activity initiated by (deployment ecs-svc/123)',
      containers: [{ name: 'App-Web', exitCode: 137 }],
    })).toBe('replaced');
  });

  it('tells failed health checks, crashes, and start failures apart', () => {
    expect(classifyStoppedTask({
      group: 'service:App-Web',
      stopCode: 'ServiceSchedulerInitiated',
      stoppedReason: 'Task failed ELB health checks in (target-group arn:aws:elasticloadbalancing:...)',
    })).toBe('health-check');
    expect(classifyStoppedTask({
      group: 'service:App-queue',
      stopCode: 'EssentialContainerExited',
      containers: [{ name: 'App-queue', exitCode: 137, reason: 'OutOfMemoryError: Container killed due to memory usage' }],
    })).toBe('crashed');
    expect(classifyStoppedTask({ group: 'service:App-Web', stopCode: 'TaskFailedToStart', stoppedReason: 'CannotPullContainerError' })).toBe('failed-to-start');
  });

  it('expects a task runner to exit 0, but not a service', () => {
    const exited = { stopCode: 'EssentialContainerExited', containers: [{ name: 'Migrator', exitCode: 0 }] };
    expect(classifyStoppedTask({ ...exited, group: 'family:app-production-Migrator' })).toBe('completed');
    expect(classifyStoppedTask({ ...exited, group: 'service:App-queue' })).toBe('crashed');
    expect(classifyStoppedTask({ ...exited, group: 'family:app-production-Migrator', containers: [{ name: 'Migrator', exitCode: 1 }] })).toBe('crashed');
  });
});

const stoppedEvent = (taskId: string, stoppedAt: string, extra: Record<string, unknown> = {}) => ({
  version: '0',
  'detail-type': 'ECS Task State Change',
  source: 'aws.ecs',
  time: stoppedAt,
  resources: [`arn:aws:ecs:us-east-1:123456789012:task/c/${taskId}`],
  detail: {
    taskArn: `arn:aws:ecs:us-east-1:123456789012:task/c/${taskId}`,
    group: 'family:app-production-Migrator',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app-production-Migrator:7',
    lastStatus: 'STOPPED',
    stopCode: 'EssentialContainerExited',
    stoppedAt,
    containers: [{ name: 'Migrator', exitCode: 1 }],
    ...extra,
  },
});

describe('the recorded ECS events', () => {
  it('reads an event in the JSON log format of Lambda, in its text format, and as is', () => {
    const event = stoppedEvent('aaaa', '2026-10-19T10:00:00Z');
    const lambdaJson = JSON.stringify({ timestamp: '2026-10-19T10:00:01Z', level: 'INFO', requestId: 'r', message: JSON.stringify(event) });
    const lambdaText = `2026-10-19T10:00:01.000Z\tr\tINFO\t${JSON.stringify(event)}`;

    for (const message of [lambdaJson, lambdaText, JSON.stringify(event)]) {
      expect(parseEcsEvent(message)).toMatchObject({ detailType: 'ECS Task State Change', detail: { taskArn: event.detail.taskArn } });
    }

    expect(parseEcsEvent('{"level":"INFO","message":"not an event"}')).toBeUndefined();
  });

  it('keeps one stop per task, in the window, with the task runner crash it records', () => {
    const events = [
      stoppedEvent('aaaa', '2026-10-19T10:00:00Z'),
      // ECS can send STOPPED twice for the same task.
      stoppedEvent('aaaa', '2026-10-19T10:00:00Z'),
      stoppedEvent('bbbb', '2026-10-17T10:00:00Z'),
      stoppedEvent('cccc', '2026-10-19T11:00:00Z', { lastStatus: 'RUNNING' }),
    ].map((event) => parseEcsEvent(JSON.stringify(event))!);

    expect(stoppedTasksFromEvents(events, window)).toEqual([expect.objectContaining({
      taskId: 'aaaa',
      group: 'family:app-production-Migrator',
      revision: 'app-production-Migrator:7',
      category: 'crashed',
      containers: [{ name: 'Migrator', exitCode: 1 }],
    })]);
  });

  it('records what status reads of a stopped task, but not the overrides it was started with', async () => {
    const { handler } = await import(`data:text/javascript,${encodeURIComponent(ECS_EVENT_RECORDER_SOURCE)}`);
    const event = stoppedEvent('aaaa', '2026-10-19T10:00:00Z', {
      overrides: { containerOverrides: [{ name: 'Migrator', command: ['php', 'artisan', 'db:seed', '--password=hunter2'], environment: [{ name: 'DB_PASSWORD', value: 'hunter2' }] }] },
      attachments: [{ details: [{ name: 'privateIPv4Address', value: '10.0.0.1' }] }],
    });
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { logged.push(line); });

    try {
      await handler(event);
    } finally {
      log.mockRestore();
    }

    const recorded = logged[0];
    expect(recorded).not.toContain('hunter2');
    expect(recorded).not.toContain('10.0.0.1');
    expect(stoppedTasksFromEvents([parseEcsEvent(recorded)!], window)).toEqual([expect.objectContaining({
      taskId: 'aaaa',
      revision: 'app-production-Migrator:7',
      category: 'crashed',
      containers: [{ name: 'Migrator', exitCode: 1 }],
    })]);
  });

  it("matches the cluster's services by ARN", () => {
    expect(serviceEventPattern('arn:aws:ecs:us-east-1:123456789012:cluster/app-production-AppClusterCluster-abc').resources)
      .toEqual([{ prefix: 'arn:aws:ecs:us-east-1:123456789012:service/app-production-AppClusterCluster-abc/' }]);
  });
});

describe('historyAttention', () => {
  const exit = (exitCode: number) => toProcessExit({
    timestamp: NOW - 1000,
    service: 'web',
    container: 'App-Web',
    logGroup: 'g',
    logStream: 's',
    message: '',
    json: { sst_laravel: 'process_exit', process: 'pulse', exit_code: exitCode, action: 'restart' },
  })!;

  it('flags processes that exit with an error, not those that exit cleanly and restart', () => {
    expect(historyAttention([], [], [exit(0), exit(0)], [])).toEqual([]);
    expect(historyAttention([], [], [exit(0), exit(1), exit(137)], [])).toEqual([
      `web pulse: exited 2 times, last ${new Date(NOW - 1000).toISOString()} with code 137`,
    ]);
  });

  it('reports a task in the day it stopped, even when its event was recorded the next day', async () => {
    const recordedAt = Date.parse('2026-10-19T00:00:01Z');
    const event = stoppedEvent('aaaa', '2026-10-18T23:59:59Z');
    const logs = { send: vi.fn(async (command: any) => ({
      events: recordedAt >= command.input.startTime && recordedAt <= command.input.endTime
        ? [{ timestamp: recordedAt, logStreamName: 's', message: JSON.stringify(event) }]
        : [],
    })) };
    const empty = { send: vi.fn(async () => ({})) };
    const report = (start: string, end: string) => buildHistoryReport({
      ecs: empty as any, logs: logs as any, cloudwatch: empty as any, elb: empty as any,
      region: 'us-east-1', clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/c', clusterName: 'c', serviceArns: [],
      sources: [], ecsEventsLogGroup: 'events', window: { start: Date.parse(start), end: Date.parse(end) }, now: NOW,
    });

    expect((await report('2026-10-18T00:00:00Z', '2026-10-19T00:00:00Z')).stoppedTasks.tasks.map((task) => task.taskId)).toEqual(['aaaa']);
    expect((await report('2026-10-19T00:00:00Z', '2026-10-19T12:00:00Z')).stoppedTasks.tasks).toEqual([]);
  });

  it('resumes too many ECS events where it stopped reading, without losing a stop logged after that', async () => {
    const at = (time: string) => Date.parse(time);
    // ECS_EVENTS_LIMIT routine replacements logged up to 12:00:00, then a crash
    // that stopped at 11:59:59 and was logged at 12:00:01.
    const replaced = Array.from({ length: ECS_EVENTS_LIMIT }, (_, i) => ({
      timestamp: at('2026-10-19T12:00:00Z') - (ECS_EVENTS_LIMIT - 1 - i) * 1000,
      event: stoppedEvent(`r${i}`, new Date(at('2026-10-19T12:00:00Z') - (ECS_EVENTS_LIMIT - 1 - i) * 1000).toISOString(), { stopCode: 'ServiceSchedulerInitiated', group: 'service:App-Web' }),
    }));
    const crash = { timestamp: at('2026-10-19T12:00:01Z'), event: stoppedEvent('crash', '2026-10-19T11:59:59Z', { group: 'service:App-queue' }) };
    const recorded = [...replaced, crash];
    const logs = { send: vi.fn(async (command: any) => {
      const matching = recorded.filter((entry) => entry.timestamp >= command.input.startTime && entry.timestamp <= command.input.endTime);
      const offset = Number(command.input.nextToken ?? 0);
      return {
        events: matching.slice(offset, offset + 1000).map((entry) => ({ timestamp: entry.timestamp, logStreamName: 's', message: JSON.stringify(entry.event) })),
        nextToken: offset + 1000 < matching.length ? String(offset + 1000) : undefined,
      };
    }) };
    const empty = { send: vi.fn(async () => ({})) };
    const sameWindow = { start: at('2026-10-19T00:00:00Z'), end: at('2026-10-19T12:00:00.500Z') };
    const report = (ecsEventsFrom?: number) => buildHistoryReport({
      ecs: empty as any, logs: logs as any, cloudwatch: empty as any, elb: empty as any,
      region: 'us-east-1', clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/c', clusterName: 'c', serviceArns: [],
      sources: [], ecsEventsLogGroup: 'events', window: sameWindow, now: at('2026-10-19T12:30:00Z'), ecsEventsFrom,
    });

    const first = await report();
    expect(first.stoppedTasks.tasks.map((task) => task.taskId)).not.toContain('crash');
    expect(first.truncated?.ecsEvents).toBe('2026-10-19T12:00:00.001Z');
    expect(first.attention.join('\n')).toContain('--start 2026-10-19T00:00:00.000Z --end 2026-10-19T12:00:00.500Z --ecs-events-from 2026-10-19T12:00:00.001Z');

    const rest = await report(Date.parse(first.truncated!.ecsEvents!));
    expect(rest.stoppedTasks.tasks.map((task) => task.taskId)).toEqual(['crash']);
    expect(rest.truncated).toBeUndefined();
    expect(rest.attention).toEqual([expect.stringContaining('App-queue: 1 task stopped unexpectedly')]);
  });

  it('needs attention when there are more process exits than it reads, instead of passing the rest unseen', async () => {
    const exitEvent = (timestamp: number, code: number) => ({
      timestamp,
      logStreamName: '/service/App-Web/0123456789abcdef0123456789abcdef',
      message: JSON.stringify({ sst_laravel: 'process_exit', process: 'pulse', exit_code: code, action: 'restart' }),
    });
    const filters: string[] = [];
    const logs = { send: vi.fn(async (command: any) => {
      filters.push(command.input.filterPattern);
      return command.input.nextToken
        ? { events: [exitEvent(NOW - 1000, 1)] }
        : { events: Array.from({ length: PROCESS_EXITS_LIMIT }, (_, i) => exitEvent(window.start + i, 1)), nextToken: 'more' };
    }) };
    const empty = { send: vi.fn(async () => ({})) };

    const report = await buildHistoryReport({
      ecs: empty as any, logs: logs as any, cloudwatch: empty as any, elb: empty as any,
      region: 'us-east-1', clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/c', clusterName: 'c', serviceArns: [],
      sources: [{ logGroup: 'g', service: 'web', kind: 'web', container: 'App-Web' }],
      window,
    });

    // Clean exits never count against the limit: only those with an error are read.
    expect(filters[0]).toBe('{ $.sst_laravel = "process_exit" && $.exit_code != 0 }');
    expect(report.truncated?.processExits).toBe(new Date(window.start + PROCESS_EXITS_LIMIT).toISOString());
    expect(report.attention).toContainEqual(expect.stringContaining(`more than ${PROCESS_EXITS_LIMIT} process exits with an error`));
  });

  it('flags rolled-back deployments, missing tasks, unexpected stops, and alarms', () => {
    const attention = historyAttention(
      [{ service: 'App-Web', running: 1, desired: 2, events: [], deployments: [{ status: 'ROLLBACK_SUCCESSFUL', revision: 'App-Web-Task:9', startedAt: '2026-10-19T09:00:00.000Z' }] }],
      [
        { taskId: 'a', group: 'service:App-Web', containers: [], category: 'replaced' },
        { taskId: 'b', group: 'service:App-Web', containers: [], category: 'health-check', stoppedAt: '2026-10-19T09:05:00.000Z' },
      ],
      [],
      [{ name: 'web-5xx', state: 'ALARM' }, { name: 'web-latency', state: 'OK' }],
    );

    expect(attention).toHaveLength(4);
    expect(attention.join('\n')).toMatch(/App-Web-Task:9 .* ROLLBACK_SUCCESSFUL/);
    expect(attention.join('\n')).toContain('App-Web: 1 task stopped unexpectedly, last 2026-10-19T09:05:00.000Z (health-check)');
    expect(attention.join('\n')).not.toContain('web-latency');
  });
});

describe('queue:status', () => {
  const empty = Object.fromEntries(Object.keys(QUEUE_QUERIES).map((key) => [key, []])) as unknown as Parameters<typeof buildQueueReport>[0];

  it('takes the last run of each scheduled task: a later success clears an earlier failure', () => {
    const schedule = combineSchedule(
      [
        { task: 'php artisan reports:daily', runs: '2', lastFinished: '2026-10-19 06:00:05.000', lastExitCode: '0', expression: '0 6 * * *' },
        { task: 'php artisan sync', runs: '3', lastFinished: '2026-10-19 11:00:02.000', lastExitCode: '1' },
      ],
      [
        { task: 'php artisan reports:daily', failures: '1', lastFailed: '2026-10-18 06:00:05.000', lastError: 'boom' },
        // A callback that throws only reports the failure.
        { task: 'Closure', failures: '1', lastFailed: '2026-10-19 11:30:00.000', lastError: 'nope' },
      ],
      [{ task: 'php artisan backup', skips: '24', lastSkipped: '2026-10-19 11:00:00.000' }],
    );

    expect(Object.fromEntries(schedule.map((task) => [task.task, task.lastStatus]))).toEqual({
      'php artisan reports:daily': 'ok',
      'php artisan sync': 'failed',
      Closure: 'failed',
      'php artisan backup': 'skipped',
    });
  });

  it('notices a queue the scheduler stopped sampling, even next to a fresh one, in a past window too', () => {
    const rows = {
      ...empty,
      queues: [
        { connection: 'redis', queue: 'default', size: '3', maxSize: '40', sampledAt: '2026-10-19 11:59:30.000' },
        { connection: 'redis', queue: 'mail', size: '0', maxSize: '2', sampledAt: '2026-10-19 11:30:00.000' },
      ],
    };

    expect(buildQueueReport(rows, window, { now: NOW }).attention).toEqual([
      'redis/mail: no size sample since 2026-10-19T11:30:00.000Z: the scheduler stopped, or no longer samples it',
    ]);
    expect(buildQueueReport(rows, { start: window.start, end: Date.parse('2026-10-19T11:40:00Z') }, { now: NOW }).attention).toEqual([]);
    expect(buildQueueReport(rows, { start: window.start, end: Date.parse('2026-10-19T11:45:00Z') }, { now: NOW }).attention).toHaveLength(1);
  });

  it('notices when no queue was sampled at all, unless the app runs no scheduler', () => {
    const rows = { ...empty, scheduleFinished: [{ task: 'php artisan sync', runs: '3', lastFinished: '2026-10-19 11:00:02.000', lastExitCode: '0' }] };

    expect(buildQueueReport(rows, window, { now: NOW }).attention).toEqual([
      expect.stringContaining('no queue size samples in the window'),
    ]);
    expect(buildQueueReport(rows, window, { now: NOW, samples: false }).attention).toEqual([]);
  });

  it('counts the runs that exited non-zero as failures, and those that threw as runs', () => {
    const [task] = combineSchedule(
      [{ task: 'php artisan sync', runs: '5', lastFinished: '2026-10-19 11:00:02.000', lastExitCode: '0' }],
      [{ task: 'php artisan sync', failures: '1', lastFailed: '2026-10-19 08:00:00.000', lastError: 'boom' }],
      [],
      // Laravel 10 and 11: the exit code of a failed run is only in schedule_finished.
      [{ task: 'php artisan sync', failures: '2', lastFailed: '2026-10-19 10:00:02.000' }],
    );

    expect(task).toMatchObject({ runs: 6, failures: 3, lastFailed: '2026-10-19T10:00:02.000Z', lastStatus: 'ok' });
  });

  it('flags failed jobs and a backlog over --max-size', () => {
    const report = buildQueueReport({
      ...empty,
      failedJobs: [{ job: 'App\\Jobs\\SendInvoice', connection: 'redis', queue: 'default', failures: '4', lastSeen: '2026-10-19 11:59:00.000', exception: 'RuntimeException', lastMessage: 'SMTP down' }],
      queues: [{ connection: 'redis', queue: 'default', size: '120', maxSize: '200', sampledAt: '2026-10-19 11:59:30.000' }],
    }, window, { now: NOW, maxSize: 100 });

    expect(report.attention).toEqual([
      'App\\Jobs\\SendInvoice failed 4 times on redis/default, last 2026-10-19T11:59:00.000Z: RuntimeException SMTP down',
      'redis/default has 120 jobs waiting (more than 100)',
    ]);
    expect(report.queues[0]).toMatchObject({ size: 120, maxSize: 200 });
  });

  it('says when there are no events at all', () => {
    expect(buildQueueReport(empty, window, { now: NOW })).toMatchObject({ noEvents: true, attention: [] });
  });
});

describe('status targets', () => {
  it('checks a fresh checkout by cluster, but never trusts outputs of another stage or saved targets without outputs', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-status-'));
    const manifest = {
      version: 1, app: 'app', stage: 'production', taskDefinitions: [],
      services: [{ cluster: 'c', service: 's', taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/web:2' }],
    };

    expect(readStageTargets(app, {}, 'production')).toBeUndefined();
    expect(readStageTargets(app, { deployment: manifest }, 'production')?.services).toHaveLength(1);

    saveDeploymentTargets(app, manifest as any);
    expect(() => readStageTargets(app, {}, 'production')).toThrow('Missing, invalid, or wrong-stage deployment output');
  });
});
