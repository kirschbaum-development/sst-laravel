import { DescribeTasksCommand, ECSClient, ListClustersCommand, ListTasksCommand, Task } from '@aws-sdk/client-ecs';
import { select } from '@inquirer/prompts';
import { extractLaravelComponents, extractSstProjectName, findSstConfig } from './sst-config.js';

export interface EcsCluster {
  clusterArn: string;
  /** The `LaravelService` name from sst.config.ts. Unknown with `--cluster`. */
  component?: string;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The name SST gives the ECS cluster of a `LaravelService`:
 * `<app>-<stage>-<component>ClusterCluster-<random>`, where the component
 * name keeps only its letters and digits. Without the app name, any app
 * matches.
 */
export function clusterNamePattern(app: string | null, stage: string, component: string): RegExp {
  const name = component.replace(/[^a-zA-Z0-9]/g, '');
  const appPattern = app ? escapeRegExp(app) : '.+';

  return new RegExp(`^${appPattern}-${escapeRegExp(stage)}-${escapeRegExp(name)}ClusterCluster-[a-z]+$`);
}

/** The ECS service a task belongs to, from its `service:<name>` group. */
export function taskServiceName(task: Task): string | undefined {
  return task.group?.startsWith('service:') ? task.group.slice('service:'.length) : undefined;
}

/**
 * The container is named after the service in sst.config.ts
 * (`<component>-Web`), even when a transform gives the ECS service another
 * name.
 */
const containerName = (task: Task) => task.containers?.[0]?.name ?? '';

/**
 * Picks the cluster of the stage from the cluster names. The exact name
 * comes first. When none has it (the app name in the config was not read
 * right, or SST shortened a very long name), a single cluster of the stage
 * and component from any app is taken, but never one of several.
 */
export function pickCluster(clusterArns: string[], app: string | null, stage: string, component: string) {
  const named = (pattern: RegExp) => clusterArns.filter((arn) => pattern.test(arn.split('/').pop() ?? ''));
  const exact = app ? named(clusterNamePattern(app, stage, component)) : [];
  const candidates = exact.length > 0 ? exact : named(clusterNamePattern(null, stage, component));

  return { clusterArn: candidates.length === 1 ? candidates[0] : undefined, candidates };
}

/**
 * Finds the tasks of the service a `[service]` argument names: `web`,
 * `reverb`, or a worker name. `worker` also stands for any worker, when none
 * has that name.
 *
 * With the component known, it compares the ECS service names, which are
 * `<component>-Web`, `<component>-Reverb`, and `<component>-<worker>`.
 * Without it (`--cluster`), it looks for the name in the container names.
 */
export function findServiceTasks(tasks: Task[], service: string, component?: string): Task[] {
  if (!component) {
    const suffix = `-${service}`.toLowerCase();
    return tasks.filter((task) => (task.containers?.[0]?.name ?? '').toLowerCase().includes(suffix));
  }

  const role = service === 'web' ? 'Web' : service === 'reverb' ? 'Reverb' : service;
  const expected = `${component}-${role}`;
  const exact = tasks.filter((task) => containerName(task) === expected || taskServiceName(task) === expected);

  if (exact.length > 0 || service !== 'worker') {
    return exact;
  }

  const notWorkers = [`${component}-Web`, `${component}-Reverb`];

  return tasks.filter((task) => {
    const name = containerName(task);
    return name.startsWith(`${component}-`) && !notWorkers.includes(name);
  });
}

async function listClusterArns(ecsClient: ECSClient): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(new ListClustersCommand({ nextToken }));
    arns.push(...(response.clusterArns ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return arns;
}

/** Every running task of the cluster, described. */
export async function listRunningTasks(ecsClient: ECSClient, clusterArn: string): Promise<Task[]> {
  const taskArns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(new ListTasksCommand({ cluster: clusterArn, desiredStatus: 'RUNNING', nextToken }));
    taskArns.push(...(response.taskArns ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  const tasks: Task[] = [];

  // DescribeTasks takes up to 100 tasks at a time.
  for (let i = 0; i < taskArns.length; i += 100) {
    const response = await ecsClient.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: taskArns.slice(i, i + 100) }));
    tasks.push(...(response.tasks ?? []));
  }

  return tasks;
}

/**
 * The ECS cluster of the stage: the one `--cluster` names, or the cluster of
 * the `LaravelService` in sst.config.ts, matched by its exact name.
 */
export async function findCluster(ecsClient: ECSClient, stage: string, clusterOption?: string): Promise<EcsCluster> {
  if (clusterOption) {
    return { clusterArn: clusterOption };
  }

  const configPath = findSstConfig();
  if (!configPath) {
    console.error('Error: Could not find sst.config.ts or sst.config.js in current directory.');
    console.error('Please use --cluster flag to specify cluster ARN manually.');
    process.exit(1);
  }

  const components = extractLaravelComponents(configPath);

  if (components.length === 0) {
    console.error('Error: No Laravel components found in SST config.');
    console.error('Please use --cluster flag to specify cluster ARN manually.');
    process.exit(1);
  }

  if (components.length > 1) {
    console.error('Error: Multiple Laravel components found in SST config.');
    console.error(`Found: ${components.join(', ')}`);
    console.error('Please use --cluster flag to specify which cluster to connect to.');
    process.exit(1);
  }

  const app = extractSstProjectName(configPath);
  const component = components[0];
  const clusterArns = await listClusterArns(ecsClient);
  const { clusterArn, candidates } = pickCluster(clusterArns, app, stage, component);

  if (candidates.length > 1) {
    console.error(`Error: Several clusters match stage "${stage}" and component "${component}":`);
    candidates.forEach((arn) => console.error(`  - ${arn.split('/').pop()}`));
    console.error('Please use --cluster flag to specify which cluster to connect to.');
    process.exit(1);
  }

  if (!clusterArn) {
    console.error(`Error: No cluster found for app "${app ?? '(any)'}", stage "${stage}", and component "${component}".`);

    if (clusterArns.length === 0) {
      console.error('No ECS clusters found in this region.');
    } else {
      console.error('Available clusters:');
      clusterArns.forEach((arn) => console.error(`  - ${arn.split('/').pop()}`));
    }

    process.exit(1);
  }

  console.log(`Auto-detected cluster: ${clusterArn.split('/').pop()}`);
  return { clusterArn, component };
}

export async function findClusterArn(ecsClient: ECSClient, stage: string, clusterOption?: string): Promise<string> {
  return (await findCluster(ecsClient, stage, clusterOption)).clusterArn;
}

export async function findTask(
  ecsClient: ECSClient,
  cluster: EcsCluster,
  service?: string,
  selectPrompt: string = 'Select a task to connect to:'
): Promise<Task> {
  const tasks = await listRunningTasks(ecsClient, cluster.clusterArn);

  if (tasks.length === 0) {
    console.error('No running tasks found in cluster');
    process.exit(1);
  }

  const matchingTask = service ? findServiceTasks(tasks, service, cluster.component)[0] : undefined;

  if (matchingTask) {
    return matchingTask;
  }

  if (service) {
    console.log(`\nNo running task found matching service: ${service}`);
  }
  console.log('Available tasks in cluster:\n');

  return select({
    message: selectPrompt,
    choices: tasks.map((task) => {
      const taskId = task.taskArn?.split('/').pop() || '';
      const name = taskServiceName(task) ?? task.containers?.[0]?.name ?? 'unknown';

      return {
        name: `${name} (${taskId.substring(0, 8)}...) - ${task.lastStatus || 'unknown'}`,
        value: task,
        description: `Task: ${taskId}`,
      };
    }),
  });
}
