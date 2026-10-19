import { CloudWatchClient, DescribeAlarmsCommand, MetricAlarm, CompositeAlarm } from '@aws-sdk/client-cloudwatch';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeServiceRevisionsCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListServiceDeploymentsCommand,
  ListServicesCommand,
  ListTasksCommand,
  Service,
} from '@aws-sdk/client-ecs';
import { DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { fetchLogLines, LogLine, parseJsonMessage } from './log-events.js';
import type { LogSource } from './log-sources.js';
import { taskDefinitionRevision } from './rollout.js';
import type { TimeWindow } from './time.js';

type Time = Date | string | number | undefined;

const toMillis = (time: Time): number | undefined => {
  if (time === undefined || time === null) return undefined;
  const value = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : Date.parse(time);
  return Number.isNaN(value) ? undefined : value;
};

const toIso = (time: Time): string | undefined => {
  const value = toMillis(time);
  return value === undefined ? undefined : new Date(value).toISOString();
};

const inWindow = (time: Time, window: TimeWindow) => {
  const value = toMillis(time);
  return value !== undefined && value >= window.start && value < window.end;
};

/**
 * Why a task stopped:
 * - `replaced`: ECS replaced it in a deployment or scaled in (expected).
 * - `completed`: a standalone task (task runner) exited 0 (expected).
 * - `stopped`: someone called StopTask (expected).
 * - `crashed`: a container exited non-zero or ran out of memory, or a
 *   service's task exited on its own.
 * - `health-check`: it failed the load balancer or container health check.
 * - `failed-to-start`: it never started (image pull, environment, secrets).
 * - `infrastructure`: AWS stopped it (Spot interruption, maintenance).
 */
export type StopCategory = 'replaced' | 'completed' | 'stopped' | 'crashed' | 'health-check' | 'failed-to-start' | 'infrastructure' | 'other';

export const STOPS_NEEDING_ATTENTION: StopCategory[] = ['crashed', 'health-check', 'failed-to-start'];

export interface StoppedContainer {
  name: string;
  exitCode?: number;
  reason?: string;
}

export interface StoppedTask {
  taskId: string;
  /** `service:<name>` for a service's task, `family:<name>` for a standalone one. */
  group: string;
  /** The task definition revision, `App-Web-Task:42`. */
  revision?: string;
  startedAt?: string;
  stoppedAt?: string;
  stopCode?: string;
  stoppedReason?: string;
  containers: StoppedContainer[];
  category: StopCategory;
}

/** The fields DescribeTasks and the `ECS Task State Change` event share. */
export interface TaskLike {
  taskArn?: string;
  group?: string;
  taskDefinitionArn?: string;
  startedAt?: Time;
  stoppedAt?: Time;
  stoppingAt?: Time;
  stopCode?: string;
  stoppedReason?: string;
  containers?: Array<{ name?: string; exitCode?: number; reason?: string }>;
}

export function classifyStoppedTask(task: TaskLike): StopCategory {
  const reason = task.stoppedReason ?? '';
  const containers = task.containers ?? [];
  const failed = containers.some((container) =>
    (container.exitCode !== undefined && container.exitCode !== null && container.exitCode !== 0) || /OutOfMemory/i.test(container.reason ?? ''));

  if (task.stopCode === 'TaskFailedToStart') return 'failed-to-start';
  if (/health ?check/i.test(reason)) return 'health-check';
  if (task.stopCode === 'ServiceSchedulerInitiated') return 'replaced';
  if (task.stopCode === 'UserInitiated') return 'stopped';
  if (task.stopCode === 'SpotInterruption' || task.stopCode === 'TerminationNotice') return 'infrastructure';
  if (failed) return 'crashed';

  if (task.stopCode === 'EssentialContainerExited') {
    // A service's task runs until ECS stops it; one that exits, even with 0, is a restart.
    return task.group?.startsWith('service:') ? 'crashed' : 'completed';
  }

  return 'other';
}

export function toStoppedTask(task: TaskLike): StoppedTask {
  return {
    taskId: task.taskArn?.split('/').pop() ?? 'unknown',
    group: task.group ?? 'unknown',
    revision: task.taskDefinitionArn ? taskDefinitionRevision(task.taskDefinitionArn) : undefined,
    startedAt: toIso(task.startedAt),
    stoppedAt: toIso(task.stoppedAt ?? task.stoppingAt),
    stopCode: task.stopCode,
    stoppedReason: task.stoppedReason,
    containers: (task.containers ?? []).map((container) => ({
      name: container.name ?? 'unknown',
      ...(container.exitCode !== undefined && container.exitCode !== null ? { exitCode: container.exitCode } : {}),
      ...(container.reason ? { reason: container.reason } : {}),
    })),
    category: classifyStoppedTask(task),
  };
}

/** An event the component's recorder wrote: an EventBridge event from `aws.ecs`. */
export interface EcsEvent {
  time: number;
  detailType: string;
  resources: string[];
  detail: Record<string, any>;
}

/**
 * The EventBridge event in a line of the ECS events log group. The recorder
 * logs each event as a JSON string; Lambda's JSON log format wraps it in
 * `message`, and its text format puts a prefix before it.
 */
export function parseEcsEvent(message: string): EcsEvent | undefined {
  let value: unknown = parseJsonMessage(message) ?? parseJsonMessage(message.slice(message.indexOf('{')));

  for (let depth = 0; depth < 3 && value && typeof value === 'object'; depth++) {
    const record = value as Record<string, unknown>;

    if (typeof record['detail-type'] === 'string' && record.detail && typeof record.detail === 'object') {
      return {
        time: toMillis(record.time as string) ?? 0,
        detailType: record['detail-type'] as string,
        resources: Array.isArray(record.resources) ? (record.resources as string[]) : [],
        detail: record.detail as Record<string, any>,
      };
    }

    value = typeof record.message === 'string' ? parseJsonMessage(record.message) : record.message;
  }

  return undefined;
}

const EVENTS_SOURCE = (logGroup: string): LogSource => ({ logGroup, service: 'ecs-events', kind: 'task', container: 'ecs-events' });

export const ECS_EVENTS_LIMIT = 20000;

/**
 * How late an event can reach the log group: its time there is when the
 * recorder logged it, not when the task stopped. The events are read this
 * much around the window, and a task is reported in the window it stopped
 * in, so consecutive windows report it once.
 */
export const ECS_EVENT_DELAY_MS = 15 * 60 * 1000;

/**
 * The ECS events the component recorded in the window, oldest first. Past
 * `ECS_EVENTS_LIMIT`, `truncatedAt` says up to when they are complete.
 */
export async function readEcsEvents(logs: CloudWatchLogsClient, logGroup: string, window: TimeWindow): Promise<{ events: EcsEvent[]; truncatedAt?: number }> {
  const { lines, truncatedAt } = await fetchLogLines(logs, [EVENTS_SOURCE(logGroup)], window, { limit: ECS_EVENTS_LIMIT });
  return { events: lines.map((line) => parseEcsEvent(line.message)).filter((event): event is EcsEvent => event !== undefined), truncatedAt };
}

/** The stopped tasks from the recorded events, one per task (ECS can send STOPPED twice). */
export function stoppedTasksFromEvents(events: EcsEvent[], window: TimeWindow): StoppedTask[] {
  const tasks = new Map<string, StoppedTask>();

  for (const event of events) {
    if (event.detailType !== 'ECS Task State Change' || event.detail.lastStatus !== 'STOPPED') continue;
    const task = toStoppedTask(event.detail as TaskLike);
    if (!inWindow(task.stoppedAt ?? event.time, window)) continue;
    tasks.set(task.taskId, task);
  }

  return sortByStop([...tasks.values()]);
}

const sortByStop = (tasks: StoppedTask[]) => tasks.sort((a, b) => (toMillis(a.stoppedAt) ?? 0) - (toMillis(b.stoppedAt) ?? 0));

/** The stopped tasks ECS still lists: about the last hour only. */
export async function listStoppedTasks(ecs: ECSClient, clusterArn: string, window: TimeWindow): Promise<StoppedTask[]> {
  const taskArns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecs.send(new ListTasksCommand({ cluster: clusterArn, desiredStatus: 'STOPPED', nextToken }));
    taskArns.push(...(response.taskArns ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  const tasks: StoppedTask[] = [];

  for (let i = 0; i < taskArns.length; i += 100) {
    const response = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: taskArns.slice(i, i + 100) }));
    tasks.push(...(response.tasks ?? []).filter((task) => task.lastStatus === 'STOPPED').map((task) => toStoppedTask(task)));
  }

  return sortByStop(tasks.filter((task) => !task.stoppedAt || inWindow(task.stoppedAt, window)));
}

export interface ServiceEvent {
  time: string;
  message: string;
}

export interface ServiceDeployment {
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  reason?: string;
  revision?: string;
}

export interface ServiceHistory {
  service: string;
  running: number;
  desired: number;
  events: ServiceEvent[];
  deployments: ServiceDeployment[];
}

/** ECS repeats this one every few hours; it says nothing new. */
const ROUTINE_EVENT = /has reached a steady state\.?$/;

export async function describeClusterServices(ecs: ECSClient, clusterArn: string, serviceArns?: string[]): Promise<Service[]> {
  const arns = serviceArns ?? [];

  if (!serviceArns) {
    let nextToken: string | undefined;

    do {
      const response = await ecs.send(new ListServicesCommand({ cluster: clusterArn, nextToken }));
      arns.push(...(response.serviceArns ?? []));
      nextToken = response.nextToken;
    } while (nextToken);
  }

  const services: Service[] = [];

  for (let i = 0; i < arns.length; i += 10) {
    const response = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: arns.slice(i, i + 10) }));
    services.push(...(response.services ?? []).filter((service) => service.status === 'ACTIVE'));
  }

  return services;
}

/**
 * Each service's events (ECS keeps the last 100) and deployments (kept 90
 * days) in the window, newest last. Routine steady-state events are left out.
 */
export async function serviceHistory(ecs: ECSClient, clusterArn: string, services: Service[], window: TimeWindow): Promise<ServiceHistory[]> {
  const histories: ServiceHistory[] = [];

  for (const service of services) {
    const events = (service.events ?? [])
      .filter((event) => inWindow(event.createdAt, window) && !ROUTINE_EVENT.test(event.message ?? ''))
      .map((event) => ({ time: toIso(event.createdAt)!, message: event.message ?? '' }))
      .sort((a, b) => a.time.localeCompare(b.time));

    const briefs = [];
    let nextToken: string | undefined;

    do {
      const response = await ecs.send(new ListServiceDeploymentsCommand({
        cluster: clusterArn,
        service: service.serviceArn,
        createdAt: { after: new Date(window.start), before: new Date(window.end) },
        nextToken,
      }));
      briefs.push(...(response.serviceDeployments ?? []));
      nextToken = response.nextToken;
    } while (nextToken);

    const revisions = new Map<string, string | undefined>();
    const revisionArns = [...new Set(briefs.map((brief) => brief.targetServiceRevisionArn).filter((arn): arn is string => Boolean(arn)))];

    for (let i = 0; i < revisionArns.length; i += 20) {
      const response = await ecs.send(new DescribeServiceRevisionsCommand({ serviceRevisionArns: revisionArns.slice(i, i + 20) }));
      for (const revision of response.serviceRevisions ?? []) {
        revisions.set(revision.serviceRevisionArn!, revision.taskDefinition ? taskDefinitionRevision(revision.taskDefinition) : undefined);
      }
    }

    const deployments = briefs
      .map((brief) => ({
        startedAt: toIso(brief.startedAt ?? brief.createdAt),
        finishedAt: toIso(brief.finishedAt),
        status: brief.status,
        reason: brief.statusReason,
        revision: brief.targetServiceRevisionArn ? revisions.get(brief.targetServiceRevisionArn) : undefined,
      }))
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));

    histories.push({
      service: service.serviceName ?? 'unknown',
      running: service.runningCount ?? 0,
      desired: service.desiredCount ?? 0,
      events,
      deployments,
    });
  }

  return histories;
}

export const FAILED_DEPLOYMENT_STATUSES = ['ROLLBACK_REQUESTED', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_SUCCESSFUL', 'ROLLBACK_FAILED', 'STOPPED'];

/** A process the container's s6 supervisor saw exit, from its `process_exit` line. */
export interface ProcessExit {
  time: string;
  service: string;
  task?: string;
  process: string;
  exitCode?: number;
  /** `restart`: s6 restarted it in place. `stop_container`: the container stopped, so ECS replaces it. */
  action?: string;
}

/**
 * Only the exits with an error: a process that exits 0 and restarts is
 * expected, and some (`queue:work --max-time`) do so all day.
 */
export const PROCESS_EXIT_FILTER = '{ $.sst_laravel = "process_exit" && $.exit_code != 0 }';

export const PROCESS_EXITS_LIMIT = 5000;

/**
 * The background processes that exited with an error in the window. Past
 * `PROCESS_EXITS_LIMIT` in a log group, `truncatedAt` says up to when they
 * are complete.
 */
export async function readProcessExits(logs: CloudWatchLogsClient, sources: LogSource[], window: TimeWindow): Promise<{ exits: ProcessExit[]; truncatedAt?: number }> {
  const { lines, truncatedAt } = await fetchLogLines(logs, sources, window, { filterPattern: PROCESS_EXIT_FILTER, limit: PROCESS_EXITS_LIMIT });
  return { exits: lines.map(toProcessExit).filter((exit): exit is ProcessExit => exit !== undefined), truncatedAt };
}

export function toProcessExit(line: LogLine): ProcessExit | undefined {
  if (line.json?.sst_laravel !== 'process_exit') return undefined;

  return {
    time: new Date(line.timestamp).toISOString(),
    service: line.service,
    task: line.task,
    process: String(line.json.process ?? 'unknown'),
    exitCode: typeof line.json.exit_code === 'number' ? line.json.exit_code : undefined,
    action: typeof line.json.action === 'string' ? line.json.action : undefined,
  };
}

export interface AlarmState {
  name: string;
  state: string;
  reason?: string;
  updatedAt?: string;
}

type Dimension = { Name?: string; Value?: string };

const alarmDimensions = (alarm: MetricAlarm): Dimension[] => [
  ...(alarm.Dimensions ?? []),
  ...(alarm.Metrics ?? []).flatMap((metric) => metric.MetricStat?.Metric?.Dimensions ?? []),
];

/** The dimension values that point at the stage: its cluster, services, target groups, and load balancers. */
export interface AlarmTargets {
  clusterName: string;
  serviceNames: string[];
  /** `targetgroup/<name>/<id>` */
  targetGroups: string[];
  /** `app/<name>/<id>` */
  loadBalancers: string[];
}

export function alarmMatches(alarm: MetricAlarm, targets: AlarmTargets): boolean {
  return alarmDimensions(alarm).some(({ Name, Value }) =>
    (Name === 'ClusterName' && Value === targets.clusterName) ||
    (Name === 'ServiceName' && targets.serviceNames.includes(Value ?? '')) ||
    (Name === 'TargetGroup' && targets.targetGroups.includes(Value ?? '')) ||
    (Name === 'LoadBalancer' && targets.loadBalancers.includes(Value ?? '')));
}

/** The load balancer target groups and load balancers of the services, as alarm dimension values. */
export async function alarmTargets(
  elb: ElasticLoadBalancingV2Client,
  clusterName: string,
  services: Service[],
): Promise<AlarmTargets> {
  const targetGroupArns = [...new Set(services.flatMap((service) => service.loadBalancers ?? []).map((lb) => lb.targetGroupArn).filter((arn): arn is string => Boolean(arn)))];
  const loadBalancers = new Set<string>();

  if (targetGroupArns.length > 0) {
    const response = await elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: targetGroupArns }));
    for (const arn of (response.TargetGroups ?? []).flatMap((group) => group.LoadBalancerArns ?? [])) {
      const suffix = arn.split(':loadbalancer/')[1];
      if (suffix) loadBalancers.add(suffix);
    }
  }

  return {
    clusterName,
    serviceNames: services.map((service) => service.serviceName!).filter(Boolean),
    targetGroups: targetGroupArns.map((arn) => arn.split(':').pop()!).filter(Boolean),
    loadBalancers: [...loadBalancers],
  };
}

/**
 * The CloudWatch alarms on the stage's cluster, services, target groups, or
 * load balancers, plus any whose name starts with one of `namePrefixes`.
 */
export async function findAlarms(cloudwatch: CloudWatchClient, targets: AlarmTargets, namePrefixes: string[] = []): Promise<AlarmState[]> {
  const metric: MetricAlarm[] = [];
  const composite: CompositeAlarm[] = [];
  let nextToken: string | undefined;

  do {
    const response = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], NextToken: nextToken }));
    metric.push(...(response.MetricAlarms ?? []));
    composite.push(...(response.CompositeAlarms ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  const named = (name?: string) => namePrefixes.some((prefix) => name?.startsWith(prefix));

  return [
    ...metric.filter((alarm) => alarmMatches(alarm, targets) || named(alarm.AlarmName)),
    ...composite.filter((alarm) => named(alarm.AlarmName)),
  ]
    .map((alarm) => ({
      name: alarm.AlarmName ?? 'unknown',
      state: alarm.StateValue ?? 'UNKNOWN',
      reason: alarm.StateReason,
      updatedAt: toIso(alarm.StateUpdatedTimestamp),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
