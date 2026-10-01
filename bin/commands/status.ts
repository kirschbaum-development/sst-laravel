import { Command } from 'commander';
import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { findClusterArn } from '../utils/ecs.js';
import { REGION_OPTION_HELP, resolveRegion } from '../utils/aws.js';

interface StatusOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  url?: string;
  path: string;
  wait?: string | boolean;
}

const DEFAULT_WAIT_SECONDS = 600;
const RETRY_SECONDS = 15;

/**
 * Without a domain, the app runs on the load balancer address over plain
 * http: port 443 is not open, so an https:// URL times out silently.
 */
export const isLoadBalancerHttpsUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.elb.amazonaws.com');
  } catch {
    return false;
  }
};

const parseWaitSeconds = (wait: string | boolean | undefined): number => {
  if (wait === undefined || wait === false) {
    return 0;
  }

  if (wait === true) {
    return DEFAULT_WAIT_SECONDS;
  }

  const seconds = parseInt(wait, 10);
  return Number.isNaN(seconds) || seconds <= 0 ? DEFAULT_WAIT_SECONDS : seconds;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pass over the tasks and the health endpoint. Returns whether anything
 * needs attention; prints the report as it goes.
 */
const checkOnce = async (
  ecsClient: ECSClient,
  clusterArn: string,
  options: StatusOptions,
): Promise<{ failed: boolean; starting: boolean }> => {
  let failed = false;
  let starting = false;

  const listed = await ecsClient.send(
    new ListTasksCommand({ cluster: clusterArn, desiredStatus: 'RUNNING' }),
  );

  if (!listed.taskArns || listed.taskArns.length === 0) {
    console.log('[FIX] tasks: no RUNNING tasks found.');
    console.log('      Check the deploy output for errors, then `npx sst-laravel logs web --stage <stage> --no-follow`.');
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
        starting = true;
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
      } else if (response.status === 502 || response.status === 503) {
        // The load balancer answers 502/503 while no task is healthy yet.
        console.log(`[FIX] health: GET ${options.path} returned ${response.status}. The load balancer has no healthy task yet; right after a deploy that usually means the task is still starting.`);
        failed = true;
        starting = true;
      } else {
        console.log(`[FIX] health: GET ${options.path} returned ${response.status}. Check env vars, migrations, and recent logs.`);
        failed = true;
      }
    } catch (error) {
      console.log(`[FIX] health: could not reach ${target} (${(error as Error).message}).`);
      if (isLoadBalancerHttpsUrl(options.url)) {
        console.log('      This is the load balancer address, which only serves http:// until you add a domain. Retry with http://.');
      } else {
        console.log('      The load balancer can take a few minutes after a deploy. If it persists, check target health and logs.');
        starting = true;
      }
      failed = true;
    }
  } else {
    console.log('[--] health: skipped (pass --url <app-url> to request the health endpoint)');
  }

  return { failed, starting };
};

export const statusCommand = new Command('status')
  .description('Check a deployment: running tasks plus an optional /up health check. Prints one summary, never secrets.')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'ECS cluster ARN (skips auto-detection)')
  .option('-r, --region <region>', REGION_OPTION_HELP)
  .option('-u, --url <url>', 'Public app URL to health-check (from the deploy output)')
  .option('-p, --path <path>', 'Health path to request', '/up')
  .option('-w, --wait [seconds]', `Keep checking while tasks start, up to this many seconds (default ${DEFAULT_WAIT_SECONDS}). Use it right after a deploy.`)
  .action(async (options: StatusOptions) => {
    try {
      if (!options.stage && !options.cluster) {
        console.error('Error: pass --stage <stage> or --cluster <arn>.');
        process.exit(1);
      }

      const region = resolveRegion(options.region);
      const ecsClient = new ECSClient({ region });

      const clusterArn = options.cluster
        ? options.cluster
        : await findClusterArn(ecsClient, options.stage as string, undefined);

      console.log(`\nCluster: ${clusterArn.split('/').pop()}`);

      if (options.url && isLoadBalancerHttpsUrl(options.url)) {
        console.log('Note: the load balancer address only serves http:// until you add a domain. Checking it over https:// will fail.');
      }

      const waitSeconds = parseWaitSeconds(options.wait);
      const deadline = Date.now() + waitSeconds * 1000;
      let result = await checkOnce(ecsClient, clusterArn, options);

      while (result.failed && result.starting && Date.now() < deadline) {
        const left = Math.round((deadline - Date.now()) / 1000);
        console.log(`\nStill starting. Checking again in ${RETRY_SECONDS}s (up to ${left}s more)...\n`);
        await sleep(RETRY_SECONDS * 1000);
        result = await checkOnce(ecsClient, clusterArn, options);
      }

      console.log('');
      if (result.failed) {
        if (result.starting && waitSeconds === 0) {
          console.log('Right after a deploy, tasks can take a few minutes to pass the health check. Run again with --wait to keep checking.');
        }
        console.log('Something needs attention. Recent logs: `npx sst-laravel logs web --stage <stage> --no-follow`.');
        process.exit(1);
      }

      console.log('Deployment looks healthy.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
