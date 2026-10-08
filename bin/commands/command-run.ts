import { Command } from 'commander';
import { ECSClient } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import { findCluster, findTask } from '../utils/ecs.js';
import { REGION_OPTION_HELP, resolveRegion } from '../utils/aws.js';

interface CommandRunOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  service: string;
  container?: string;
  raw: boolean;
}

export function buildCommandToRun(commandParts: string[], raw: boolean): string {
  if (commandParts.length === 0) {
    throw new Error('Command is required.');
  }

  const command = commandParts.join(' ');

  return raw ? command : `php artisan ${command}`;
}

export const commandRunCommand = new Command('command:run')
  .description('Run a command in a running ECS task')
  .argument('<command...>', 'Artisan command signature and options to run')
  .allowUnknownOption(true)
  .option('-s, --stage <stage>', 'SST stage name (required)')
  .option('-c, --cluster <cluster>', 'ECS cluster name (optional, auto-detected from SST config)')
  .option('-r, --region <region>', REGION_OPTION_HELP)
  .option('--service <service>', 'Service to run the command against (web, worker, or worker name)', 'web')
  .option('--container <container>', 'Container name override')
  .option('--raw', 'Run the provided command instead of prefixing it with "php artisan"', false)
  .action(async (commandParts: string[], options: CommandRunOptions) => {
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
      const matchingTask = await findTask(
        ecsClient,
        cluster,
        options.service,
        'Select a task to run the command in:',
      );

      const taskId = matchingTask.taskArn?.split('/').pop();
      const containerName = options.container || matchingTask.containers?.[0]?.name;
      const command = buildCommandToRun(commandParts, options.raw);

      if (!taskId) {
        console.error('Error: Could not determine ECS task ID.');
        process.exit(1);
      }

      if (!containerName) {
        console.error('Error: Could not determine ECS container name.');
        process.exit(1);
      }

      console.log(`Running command in task: ${taskId}`);
      console.log(`Container: ${containerName}`);
      console.log(`Command: ${command}`);
      console.log('');

      const awsCommand = spawn('aws', [
        'ecs',
        'execute-command',
        '--cluster', clusterArn,
        '--task', taskId,
        '--container', containerName,
        '--interactive',
        '--command', command,
      ], {
        stdio: 'inherit',
        env: { ...process.env, AWS_REGION: region },
      });

      awsCommand.on('exit', (code) => {
        process.exit(code || 0);
      });
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
