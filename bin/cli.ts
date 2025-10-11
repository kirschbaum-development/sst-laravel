#!/usr/bin/env node

import { Command } from 'commander';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, ListClustersCommand, Task } from '@aws-sdk/client-ecs';
import { select } from '@inquirer/prompts';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface SshOptions {
  stage?: string;
  cluster?: string;
  region: string;
}

function findSstConfig(): string | null {
  const cwd = process.cwd();
  const possiblePaths = [
    path.join(cwd, 'sst.config.ts'),
    path.join(cwd, 'sst.config.js'),
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

function extractLaravelComponents(configPath: string): string[] {
  const content = fs.readFileSync(configPath, 'utf-8');
  const regex = /new\s+Laravel\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const components: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    components.push(match[1]);
  }

  return components;
}

const program = new Command();

program
  .name('sst-laravel')
  .description('CLI tools for SST Laravel deployments')
  .version('0.0.4');

program
  .command('ssh')
  .description('SSH into a running ECS task')
  .argument('[service]', 'Service to connect to (web, worker, or worker name) - optional')
  .option('-s, --stage <stage>', 'SST stage name (required)')
  .option('-c, --cluster <cluster>', 'ECS cluster name (optional, auto-detected from SST config)')
  .option('-r, --region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .action(async (service: string | undefined, options: SshOptions) => {
    try {
      const region = options.region;
      const stage = options.stage;

      if (!stage) {
        console.error('Error: Stage is required. Use --stage flag to specify the SST stage.');
        process.exit(1);
      }

      const ecsClient = new ECSClient({ region });

      let clusterArn = options.cluster;

      if (!clusterArn) {
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

        clusterArn = matchingCluster;
        console.log(`Auto-detected cluster: ${clusterArn.split('/').pop()}`);
      }

      console.log(`Cluster ARN: ${clusterArn}`);

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
          message: 'Select a task to connect to:',
          choices
        });
      }

      const taskId = matchingTask.taskArn?.split('/').pop();

      console.log(`Connecting to task: ${taskId}`);

      const awsCommand = spawn('aws', [
        'ecs',
        'execute-command',
        '--cluster', clusterArn,
        '--task', taskId!,
        '--container', matchingTask.containers?.[0]?.name || '',
        '--interactive',
        '--command', '/bin/bash'
      ], {
        stdio: 'inherit',
        env: { ...process.env, AWS_REGION: region }
      });

      awsCommand.on('exit', (code) => {
        process.exit(code || 0);
      });

    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
