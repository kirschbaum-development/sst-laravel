import { ECSClient, ListTasksCommand, DescribeTasksCommand, ListClustersCommand, Task } from '@aws-sdk/client-ecs';
import { select } from '@inquirer/prompts';
import { findSstConfig, extractLaravelComponents } from './sst-config.js';

export interface EcsTaskResult {
  task: Task;
  clusterArn: string;
}

export async function findClusterArn(
  ecsClient: ECSClient,
  stage: string,
  clusterOption?: string
): Promise<string> {
  if (clusterOption) {
    return clusterOption;
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

  const componentName = components[0].replace(/-/g, '');
  const clusterPattern = `${stage}-${componentName}Cluster`;

  console.log(`Looking for cluster matching pattern: *${clusterPattern}`);

  const listClustersCommand = new ListClustersCommand({});
  const listClustersResponse = await ecsClient.send(listClustersCommand);

  if (!listClustersResponse.clusterArns || listClustersResponse.clusterArns.length === 0) {
    console.error('Error: No ECS clusters found in this region.');
    process.exit(1);
  }

  const matchingCluster = listClustersResponse.clusterArns.find(arn => {
    const clusterName = arn.split('/').pop();
    return clusterName?.includes(stage) && clusterName?.includes(componentName);
  });

  if (!matchingCluster) {
    console.error(`Error: No cluster found matching stage "${stage}" and component "${components[0]}".`);
    console.error('Available clusters:');
    listClustersResponse.clusterArns.forEach(arn => {
      console.error(`  - ${arn.split('/').pop()}`);
    });
    process.exit(1);
  }

  console.log(`Auto-detected cluster: ${matchingCluster.split('/').pop()}`);
  return matchingCluster;
}

export async function findTask(
  ecsClient: ECSClient,
  clusterArn: string,
  service?: string,
  selectPrompt: string = 'Select a task to connect to:'
): Promise<Task> {
  const listTasksCommand = new ListTasksCommand({
    cluster: clusterArn,
    desiredStatus: 'RUNNING'
  });

  const listTasksResponse = await ecsClient.send(listTasksCommand);

  if (!listTasksResponse.taskArns || listTasksResponse.taskArns.length === 0) {
    console.error('No running tasks found in cluster');
    process.exit(1);
  }

  const describeTasksCommand = new DescribeTasksCommand({
    cluster: clusterArn,
    tasks: listTasksResponse.taskArns
  });

  const describeTasksResponse = await ecsClient.send(describeTasksCommand);

  let matchingTask: Task | undefined;

  if (service) {
    let servicePrefix: string;
    if (service === 'web') {
      servicePrefix = '-web';
    } else if (service === 'worker') {
      servicePrefix = '-worker';
    } else {
      servicePrefix = `-${service}`;
    }

    matchingTask = describeTasksResponse.tasks?.find(task => {
      const containerName = task.containers?.[0]?.name || '';
      return containerName.toLowerCase().includes(servicePrefix.toLowerCase());
    });
  }

  if (!matchingTask) {
    if (service) {
      console.log(`\nNo running task found matching service: ${service}`);
    }
    console.log('Available tasks in cluster:\n');

    const choices = describeTasksResponse.tasks?.map(task => {
      const taskId = task.taskArn?.split('/').pop() || '';
      const containerName = task.containers?.[0]?.name || 'unknown';
      const status = task.lastStatus || 'unknown';

      return {
        name: `${containerName} (${taskId.substring(0, 8)}...) - ${status}`,
        value: task,
        description: `Task: ${taskId}`
      };
    }) || [];

    if (choices.length === 0) {
      console.error('No tasks available to select from.');
      process.exit(1);
    }

    matchingTask = await select({
      message: selectPrompt,
      choices
    });
  }

  return matchingTask;
}
