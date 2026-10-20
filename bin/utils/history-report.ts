import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { ECSClient } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  AlarmState,
  alarmTargets,
  describeClusterServices,
  ECS_EVENT_DELAY_MS,
  ECS_EVENTS_LIMIT,
  FAILED_DEPLOYMENT_STATUSES,
  findAlarms,
  listStoppedTasks,
  PROCESS_EXITS_LIMIT,
  ProcessExit,
  readEcsEvents,
  readProcessExits,
  ServiceHistory,
  serviceHistory,
  StoppedTask,
  stoppedTasksFromEvents,
  STOPS_NEEDING_ATTENTION,
} from './ecs-history.js';
import { ecsEventsLogGroupName, LogSource } from './log-sources.js';
import type { TimeWindow } from './time.js';

export interface HistoryReport {
  window: { start: string; end: string };
  services: ServiceHistory[];
  stoppedTasks: {
    /** `ecs-events`: the component's recorder (the whole window). `ecs`: what ECS still lists (about an hour). */
    source: 'ecs-events' | 'ecs';
    note?: string;
    tasks: StoppedTask[];
  };
  /** The background processes that exited with an error. */
  processExits: ProcessExit[];
  alarms: AlarmState[];
  /**
   * Set when there were too many ECS events or process exits to read them
   * all: they are complete up to these times. The attention list says so.
   * For the ECS events it is the time they were logged: resume the same
   * window with `--ecs-events-from`. For the process exits, `--start`.
   */
  truncated?: { ecsEvents?: string; processExits?: string };
  /** What needs a look, one sentence each. Empty when all is well. */
  attention: string[];
}

export interface HistoryOptions {
  ecs: ECSClient;
  logs: CloudWatchLogsClient;
  region: string;
  clusterArn: string;
  clusterName: string;
  /** Only these services (ARNs or names); all of the cluster's without. */
  serviceArns?: string[];
  sources: LogSource[];
  ecsEventsLogGroup?: string;
  window: TimeWindow;
  alarmPrefixes?: string[];
  cloudwatch?: CloudWatchClient;
  elb?: ElasticLoadBalancingV2Client;
  now?: number;
  /**
   * Resume the recorded ECS events here (their time in the log group), from
   * the `truncated.ecsEvents` of a report of the same window.
   */
  ecsEventsFrom?: number;
}

const shortTask = (taskId?: string) => (taskId ? taskId.slice(0, 8) : '-');
const groupName = (group: string) => group.replace(/^(service|family):/, '');

export async function buildHistoryReport(options: HistoryOptions): Promise<HistoryReport> {
  const { ecs, logs, window } = options;
  const services = await describeClusterServices(ecs, options.clusterArn, options.serviceArns);
  const history = await serviceHistory(ecs, options.clusterArn, services, window);

  // Read by the time the events were logged, report by the time the tasks stopped.
  const recordedWindow = {
    start: Math.max(window.start - ECS_EVENT_DELAY_MS, options.ecsEventsFrom ?? -Infinity),
    end: Math.min(window.end + ECS_EVENT_DELAY_MS, options.now ?? Date.now()),
  };
  const recorded = options.ecsEventsLogGroup ? await readEcsEvents(logs, options.ecsEventsLogGroup, recordedWindow) : undefined;
  const stoppedTasks: HistoryReport['stoppedTasks'] = recorded
    ? { source: 'ecs-events', tasks: stoppedTasksFromEvents(recorded.events, window) }
    : {
        source: 'ecs',
        note: `ECS lists stopped tasks for about an hour, and this cluster has no ECS events log group (${ecsEventsLogGroupName(options.clusterName)}). To keep the whole window, deploy a LaravelService with ecsEvents on (the default), or add an EcsEventRecorder for a cluster LaravelService didn't create, such as an sst.aws.Cluster for task runners.`,
        tasks: await listStoppedTasks(ecs, options.clusterArn, window),
      };

  const { exits: processExits, truncatedAt: exitsTruncatedAt } = await readProcessExits(logs, options.sources, window);
  const targets = await alarmTargets(options.elb ?? new ElasticLoadBalancingV2Client({ region: options.region }), options.clusterName, services);
  const alarms = await findAlarms(options.cloudwatch ?? new CloudWatchClient({ region: options.region }), targets, options.alarmPrefixes);

  const attention = historyAttention(history, stoppedTasks.tasks, processExits, alarms);
  const truncated: NonNullable<HistoryReport['truncated']> = {};

  // A window too busy to read whole could hide anything after where it stops.
  if (recorded?.truncatedAt !== undefined) {
    truncated.ecsEvents = new Date(recorded.truncatedAt).toISOString();
    // The cursor is a time in the log group, not of a stop: a task that stopped
    // before it can be logged after it. Resume the same window from it.
    const sameWindow = `--start ${new Date(window.start).toISOString()} --end ${new Date(window.end).toISOString()}`;
    attention.push(`more than ${ECS_EVENTS_LIMIT} ECS events: stopped tasks are only checked from the events logged before ${truncated.ecsEvents}. Check the rest with ${sameWindow} --ecs-events-from ${truncated.ecsEvents}.`);
  }

  if (exitsTruncatedAt !== undefined) {
    truncated.processExits = new Date(exitsTruncatedAt).toISOString();
    attention.push(`more than ${PROCESS_EXITS_LIMIT} process exits with an error in a log group: exits are only checked up to ${truncated.processExits}. Check the rest with --start ${truncated.processExits}.`);
  }

  return {
    window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
    services: history,
    stoppedTasks,
    processExits,
    alarms,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    attention,
  };
}

export function historyAttention(services: ServiceHistory[], tasks: StoppedTask[], exits: ProcessExit[], alarms: AlarmState[]): string[] {
  const attention: string[] = [];

  for (const service of services) {
    for (const deployment of service.deployments.filter((candidate) => FAILED_DEPLOYMENT_STATUSES.includes(candidate.status ?? ''))) {
      attention.push(`${service.service}: the deployment of ${deployment.revision ?? 'a revision'} started ${deployment.startedAt} ended ${deployment.status}${deployment.reason ? `: ${deployment.reason}` : ''}`);
    }

    if (service.running < service.desired) {
      attention.push(`${service.service}: ${service.running}/${service.desired} tasks running now`);
    }
  }

  const unexpected = tasks.filter((task) => STOPS_NEEDING_ATTENTION.includes(task.category));
  for (const [group, stopped] of groupBy(unexpected, (task) => groupName(task.group))) {
    const last = stopped[stopped.length - 1];
    attention.push(`${group}: ${stopped.length} task${stopped.length === 1 ? '' : 's'} stopped unexpectedly, last ${last.stoppedAt} (${describeStop(last)})`);
  }

  const failedExits = exits.filter((exit) => exit.exitCode !== 0);
  for (const [key, processExits] of groupBy(failedExits, (exit) => `${exit.service} ${exit.process}`)) {
    const last = processExits[processExits.length - 1];
    attention.push(`${key}: exited ${processExits.length} time${processExits.length === 1 ? '' : 's'}, last ${last.time} with code ${last.exitCode ?? 'unknown'}`);
  }

  for (const alarm of alarms.filter((candidate) => candidate.state === 'ALARM' && !candidate.scaling)) {
    attention.push(`alarm ${alarm.name} is in ALARM since ${alarm.updatedAt ?? 'unknown'}${alarm.reason ? `: ${alarm.reason}` : ''}`);
  }

  return attention;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }
  return groups;
}

export function describeStop(task: StoppedTask): string {
  const containers = task.containers
    .filter((container) => container.exitCode !== undefined || container.reason)
    .map((container) => `${container.name} exit ${container.exitCode ?? '?'}${container.reason ? ` (${container.reason})` : ''}`);

  return [task.category, task.stoppedReason, ...containers].filter(Boolean).join('; ');
}

/** The report as text lines, in the `[ok]`/`[FIX]` style of the rollout check. */
export function formatHistoryReport(report: HistoryReport): string[] {
  const lines = [`History ${report.window.start} to ${report.window.end}:`];

  for (const service of report.services) {
    for (const deployment of service.deployments) {
      const failed = FAILED_DEPLOYMENT_STATUSES.includes(deployment.status ?? '');
      lines.push(`[${failed ? 'FIX' : 'ok'}] deploy ${service.service}: ${deployment.revision ?? 'unknown revision'} ${deployment.status ?? ''} at ${deployment.startedAt}${deployment.reason ? ` (${deployment.reason})` : ''}`);
    }
  }

  if (!report.services.some((service) => service.deployments.length > 0)) {
    lines.push('[--] deploys: none in the window');
  }

  const { tasks, source, note } = report.stoppedTasks;
  const expected = tasks.filter((task) => !STOPS_NEEDING_ATTENTION.includes(task.category));
  for (const task of tasks.filter((candidate) => STOPS_NEEDING_ATTENTION.includes(candidate.category))) {
    lines.push(`[FIX] stopped ${groupName(task.group)} ${shortTask(task.taskId)} ${task.revision ?? ''} at ${task.stoppedAt}: ${describeStop(task)}`);
  }
  lines.push(`[${expected.length === tasks.length ? 'ok' : '..'}] stopped tasks: ${tasks.length} (${expected.length} expected: replaced, completed, or stopped on request), from ${source === 'ecs-events' ? 'the ECS events log' : 'ECS, last hour only'}`);
  if (note) {
    lines.push(`     ${note}`);
  }

  const failedExits = report.processExits.filter((exit) => exit.exitCode !== 0);
  for (const exit of failedExits) {
    lines.push(`[FIX] process ${exit.service} ${shortTask(exit.task)} ${exit.process} exited ${exit.exitCode ?? '?'} at ${exit.time} (${exit.action ?? 'unknown action'})`);
  }
  if (failedExits.length === 0) {
    lines.push('[ok] processes: no background process exited with an error');
  }

  for (const service of report.services) {
    for (const event of service.events) {
      lines.push(`[..] event ${service.service} ${event.time}: ${event.message}`);
    }
  }

  for (const alarm of report.alarms) {
    const mark = alarm.scaling ? '..' : alarm.state === 'ALARM' ? 'FIX' : alarm.state === 'OK' ? 'ok' : '..';
    lines.push(`[${mark}] alarm ${alarm.name}: ${alarm.state} since ${alarm.updatedAt ?? 'unknown'}${alarm.scaling ? ' (auto scaling)' : ''}`);
  }
  if (report.alarms.length === 0) {
    lines.push('[--] alarms: none on the cluster, its services, or load balancers');
  }

  return lines;
}
