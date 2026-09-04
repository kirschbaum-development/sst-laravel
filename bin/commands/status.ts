import { Command } from 'commander';
import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { findClusterArn } from '../utils/ecs.js';

interface StatusOptions {
  stage?: string;
  cluster?: string;
  region: string;
  url?: string;
  path: string;
}

export const statusCommand = new Command('status')
  .description('Check a deployment: running tasks plus an optional /up health check. Prints one summary, never secrets.')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'ECS cluster ARN (skips auto-detection)')
  .option('-r, --region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .option('-u, --url <url>', 'Public app URL to health-check (from the deploy output)')
  .option('-p, --path <path>', 'Health path to request', '/up')
  .action(async (options: StatusOptions) => {
    let failed = false;

    try {
      if (!options.stage && !options.cluster) {
        console.error('Error: pass --stage <stage> or --cluster <arn>.');
        process.exit(1);
      }

      const region = options.region;
      const ecsClient = new ECSClient({ region });

      const clusterArn = options.cluster
        ? options.cluster
        : await findClusterArn(ecsClient, options.stage as string, undefined);

      console.log(`\nCluster: ${clusterArn.split('/').pop()}`);

      const listed = await ecsClient.send(
        new ListTasksCommand({ cluster: clusterArn, desiredStatus: 'RUNNING' }),
      );

      if (!listed.taskArns || listed.taskArns.length === 0) {
        console.log('[FIX] tasks: no RUNNING tasks found.');
        console.log('      Check the deploy output for errors, then `npx sst-laravel logs web --stage <stage>`.');
        failed = true;
      } else {
        const described = await ecsClient.send(
          new DescribeTasksCommand({ cluster: clusterArn, tasks: listed.taskArns }),
        );

        const byService = new Map<string, { running: number; starting: number }>();
        for (const task of described.tasks ?? []) {
          const containerName = task.containers?.[0]?.name ?? 'unknown';
          // Container names look like "<stage>-<app>-<service>-<hash>".
          const service = containerName.split('-').slice(2, -1).join('-') || containerName;
          const entry = byService.get(service) ?? { running: 0, starting: 0 };
          if (task.lastStatus === 'RUNNING') {
            entry.running += 1;
          } else {
            entry.starting += 1;
          }
          byService.set(service, entry);
        }

        for (const [service, counts] of byService) {
          console.log(
            `[ok] tasks (${service}): ${counts.running} running${counts.starting > 0 ? `, ${counts.starting} still starting` : ''}`,
          );
        }
      }

      if (options.url) {
        const target = `${options.url.replace(/\/$/, '')}${options.path}`;
        try {
          const response = await fetch(target, {
            signal: AbortSignal.timeout(15000),
          });
          if (response.ok) {
            console.log(`[ok] health: GET ${options.path} returned ${response.status}`);
          } else {
            console.log(`[FIX] health: GET ${options.path} returned ${response.status}. Check env vars, migrations, and recent logs.`);
            failed = true;
          }
        } catch (error) {
          console.log(`[FIX] health: could not reach ${target} (${(error as Error).message}).`);
          console.log('      The load balancer can take a few minutes after a deploy. If it persists, check target health and logs.');
          failed = true;
        }
      } else {
        console.log('[--] health: skipped (pass --url <app-url> to request the health endpoint)');
      }

      console.log('');
      if (failed) {
        console.log('Something needs attention. Recent logs: `npx sst-laravel logs web --stage <stage>`.');
        process.exit(1);
      }

      console.log('Deployment looks healthy.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
