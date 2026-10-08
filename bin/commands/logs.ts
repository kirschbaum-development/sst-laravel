import { Command } from 'commander';
import { ECSClient, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import { findCluster, findTask } from '../utils/ecs.js';
import { REGION_OPTION_HELP, resolveRegion } from '../utils/aws.js';

interface LogsOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  follow: boolean;
  since?: string;
  filter?: string;
}

/** Drops ANSI color codes so the output reads cleanly in a terminal log or an agent transcript. */
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export const logsCommand = new Command('logs')
  .description('Print or stream the CloudWatch logs of a running ECS task')
  .argument('[service]', 'Service to stream logs from (web, worker, or worker name) - optional')
  .option('-s, --stage <stage>', 'SST stage name (required)')
  .option('-c, --cluster <cluster>', 'ECS cluster name (optional, auto-detected from SST config)')
  .option('-r, --region <region>', REGION_OPTION_HELP)
  .option('-f, --follow', 'Keep streaming new log lines (like tail -f)', true)
  .option('--no-follow', 'Print the recent logs and exit (for scripts and agents)')
  .option('--since <time>', 'Start time for logs (e.g., 5m, 1h, 2d)', '10m')
  .option('--filter <pattern>', 'Only show lines matching a CloudWatch filter pattern, e.g. "ERROR" or "?migrat ?Exception"')
  .action(async (service: string | undefined, options: LogsOptions) => {
    try {
      const region = resolveRegion(options.region);
      const stage = options.stage;

      if (!stage) {
        console.error('Error: Stage is required. Use --stage flag to specify the SST stage.');
        process.exit(1);
      }

      const ecsClient = new ECSClient({ region });

      const cluster = await findCluster(ecsClient, stage, options.cluster);
      const clusterArn = cluster.clusterArn;

      const matchingTask = await findTask(ecsClient, cluster, service, 'Select a task to stream logs from:');

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
      console.log(`${options.follow ? 'Streaming' : 'Recent'} logs from: ${containerName}`);
      console.log(`Log group: ${logGroup}`);
      if (options.follow) {
        console.log('Press Ctrl+C to stop. Use --no-follow to print the recent logs and exit.');
      }
      console.log('');

      const awsArgs = [
        'logs',
        'tail',
        logGroup,
        '--since', options.since || '10m',
        '--format', 'short',
        '--color', 'off',
      ];

      if (options.follow) {
        awsArgs.push('--follow');
      }

      if (options.filter) {
        awsArgs.push('--filter-pattern', options.filter);
      }

      // The container itself prints colored lines (e.g. the PHP image banner at
      // startup), so the output is piped through here and stripped.
      const awsCommand = spawn('aws', awsArgs, {
        stdio: ['inherit', 'pipe', 'inherit'],
        env: { ...process.env, AWS_REGION: region }
      });

      awsCommand.stdout.on('data', (chunk: Buffer) => {
        process.stdout.write(stripAnsi(chunk.toString()));
      });

      awsCommand.on('exit', (code) => {
        process.exit(code || 0);
      });

    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
