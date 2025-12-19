import { Command } from 'commander';
import { ECSClient, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import { findClusterArn, findTask } from '../utils/ecs.js';

interface LogsOptions {
  stage?: string;
  cluster?: string;
  region: string;
  follow: boolean;
  since?: string;
}

export const logsCommand = new Command('logs')
  .description('Stream CloudWatch logs from a running ECS task')
  .argument('[service]', 'Service to stream logs from (web, worker, or worker name) - optional')
  .option('-s, --stage <stage>', 'SST stage name (required)')
  .option('-c, --cluster <cluster>', 'ECS cluster name (optional, auto-detected from SST config)')
  .option('-r, --region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .option('-f, --follow', 'Follow log output (like tail -f)', true)
  .option('--since <time>', 'Start time for logs (e.g., 5m, 1h, 2d)', '10m')
  .action(async (service: string | undefined, options: LogsOptions) => {
    try {
      const region = options.region;
      const stage = options.stage;

      if (!stage) {
        console.error('Error: Stage is required. Use --stage flag to specify the SST stage.');
        process.exit(1);
      }

      const ecsClient = new ECSClient({ region });

      const clusterArn = await findClusterArn(ecsClient, stage, options.cluster);

      const matchingTask = await findTask(ecsClient, clusterArn, service, 'Select a task to stream logs from:');

      const taskDefinitionArn = matchingTask.taskDefinitionArn;

      if (!taskDefinitionArn) {
        console.error('Error: Could not find task definition ARN');
        process.exit(1);
      }

      const describeTaskDefCommand = new DescribeTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn
      });

      const taskDefResponse = await ecsClient.send(describeTaskDefCommand);
      const containerDef = taskDefResponse.taskDefinition?.containerDefinitions?.[0];
      const logConfig = containerDef?.logConfiguration;

      if (!logConfig || logConfig.logDriver !== 'awslogs') {
        console.error('Error: Task does not use CloudWatch Logs (awslogs driver)');
        process.exit(1);
      }

      const logGroup = logConfig.options?.['awslogs-group'];

      if (!logGroup) {
        console.error('Error: Could not determine CloudWatch log group');
        process.exit(1);
      }

      const containerName = matchingTask.containers?.[0]?.name || 'unknown';
      console.log(`Streaming logs from: ${containerName}`);
      console.log(`Log group: ${logGroup}`);
      console.log('');

      const awsArgs = [
        'logs',
        'tail',
        logGroup,
        '--since', options.since || '10m'
      ];

      if (options.follow) {
        awsArgs.push('--follow');
      }

      const awsCommand = spawn('aws', awsArgs, {
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
