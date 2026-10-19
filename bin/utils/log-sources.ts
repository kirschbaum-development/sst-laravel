import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CliError } from './cli.js';

/**
 * SST names the log group of each container after its cluster:
 * `/sst/cluster/<cluster>/<service resource>/<container>`. Standalone
 * `sst.aws.Task` resources in the cluster (task runners) follow the same
 * scheme, so one prefix search finds every log group of the stage, with no
 * running task and no SST outputs needed.
 */
export const clusterLogGroupPrefix = (clusterName: string) => `/sst/cluster/${clusterName}/`;

/** Where the component records the ECS events of the cluster (`ecsEvents`). */
export const ECS_EVENTS_SUFFIX = 'sst-laravel/ecs-events';
export const ecsEventsLogGroupName = (clusterName: string) => `${clusterLogGroupPrefix(clusterName)}${ECS_EVENTS_SUFFIX}`;

export const clusterNameFromArn = (clusterArn: string) => clusterArn.split('/').pop() ?? clusterArn;

export type LogSourceKind = 'web' | 'reverb' | 'worker' | 'task';

export interface LogSource {
  logGroup: string;
  /** `web`, `reverb`, the worker name, or the container name of another task in the cluster. */
  service: string;
  kind: LogSourceKind;
  /** The container name, `<component>-Web` for example. */
  container: string;
}

/**
 * What a log group of the cluster holds, or nothing for the ECS events group
 * and names that don't follow SST's scheme. With the component known,
 * `<component>-Web`, `<component>-Reverb`, and `<component>-<worker>` are its
 * services and anything else is another task in the cluster.
 */
export function describeLogGroup(logGroup: string, clusterName: string, component?: string): LogSource | undefined {
  const prefix = clusterLogGroupPrefix(clusterName);

  if (!logGroup.startsWith(prefix)) {
    return undefined;
  }

  const rest = logGroup.slice(prefix.length);

  if (rest === ECS_EVENTS_SUFFIX) {
    return undefined;
  }

  const segments = rest.split('/');

  if (segments.length !== 2 || !segments[1]) {
    return undefined;
  }

  const container = segments[1];
  const source = (kind: LogSourceKind, service: string): LogSource => ({ logGroup, service, kind, container });

  if (component) {
    if (container === `${component}-Web`) return source('web', 'web');
    if (container === `${component}-Reverb`) return source('reverb', 'reverb');
    if (container.startsWith(`${component}-`)) return source('worker', container.slice(component.length + 1));

    return source('task', container);
  }

  // Without the component (`--cluster`), only web and Reverb can be told apart.
  if (container.endsWith('-Web')) return source('web', 'web');
  if (container.endsWith('-Reverb')) return source('reverb', 'reverb');

  return source('task', container);
}

/** Every log group name under the prefix. */
export async function listLogGroups(client: CloudWatchLogsClient, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }));
    names.push(...(response.logGroups ?? []).map((group) => group.logGroupName!).filter(Boolean));
    nextToken = response.nextToken;
  } while (nextToken);

  return names;
}

export interface ClusterLogGroups {
  sources: LogSource[];
  /** The ECS events group, when the component records them. */
  ecsEvents?: string;
}

/** The log groups of the cluster: one per container, and the ECS events group. */
export async function discoverLogGroups(client: CloudWatchLogsClient, clusterName: string, component?: string): Promise<ClusterLogGroups> {
  const names = await listLogGroups(client, clusterLogGroupPrefix(clusterName));
  const sources = names
    .map((name) => describeLogGroup(name, clusterName, component))
    .filter((source): source is LogSource => source !== undefined)
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.service.localeCompare(b.service));
  const eventsGroup = ecsEventsLogGroupName(clusterName);

  return { sources, ecsEvents: names.includes(eventsGroup) ? eventsGroup : undefined };
}

const kindOrder = (kind: LogSourceKind) => ['web', 'reverb', 'worker', 'task'].indexOf(kind);

/**
 * The sources a `[service]` argument names: all of them without one; `web`,
 * `reverb`, or `worker` (every worker, unless one is named `worker`); or a
 * worker or task by its name or container name, in any case.
 */
export function selectLogSources(sources: LogSource[], service?: string): LogSource[] {
  if (!service || service === 'all') {
    return sources;
  }

  const wanted = service.toLowerCase();
  const byName = sources.filter((source) => source.service.toLowerCase() === wanted || source.container.toLowerCase() === wanted);

  if (byName.length > 0) {
    return byName;
  }

  if (wanted === 'worker' || wanted === 'workers') {
    const workers = sources.filter((source) => source.kind === 'worker');

    if (workers.length > 0) {
      return workers;
    }
  }

  throw new CliError(
    sources.length > 0
      ? `No logs of "${service}". Services with logs: ${sources.map((source) => source.service).join(', ')}.`
      : 'The cluster has no log groups yet.',
    2,
  );
}
