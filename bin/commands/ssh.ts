import { Command } from 'commander';
import { ECSClient } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import { findClusterArn, findTask } from '../utils/ecs.js';

interface SshOptions {
  stage?: string;
  cluster?: string;
  region: string;
}

export const sshCommand = new Command('ssh')
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

      const clusterArn = await findClusterArn(ecsClient, stage, options.cluster);
      console.log(`Cluster ARN: ${clusterArn}`);

      const matchingTask = await findTask(ecsClient, clusterArn, service, 'Select a task to connect to:');

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
