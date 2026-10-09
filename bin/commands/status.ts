import { Command } from 'commander';
import { ECSClient } from '@aws-sdk/client-ecs';
import { findClusterArn } from '../utils/ecs.js';
import { APP_REGION_OPTION_HELP } from '../utils/aws.js';
import { resolveAppRegion } from '../utils/sst-config.js';
import { readSavedAppUrl } from '../utils/app-url.js';
import { DEFAULT_WAIT_SECONDS, isLoadBalancerHttpsUrl, RETRY_SECONDS, verifyDeployment } from '../utils/deployment-check.js';

export { isLoadBalancerHttpsUrl };

interface StatusOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  url?: string;
  path: string;
  wait?: string | boolean;
}

export const parseWaitSeconds = (wait: string | boolean | undefined): number => {
  if (wait === undefined || wait === false) {
    return 0;
  }

  if (wait === true) {
    return DEFAULT_WAIT_SECONDS;
  }

  const seconds = parseInt(wait, 10);
  return Number.isNaN(seconds) || seconds <= 0 ? DEFAULT_WAIT_SECONDS : seconds;
};

export const statusCommand = new Command('status')
  .description('Check a deployment: whether each service runs its last deployment, plus an optional /up health check. Fails when a deployment was rolled back. Prints one summary, never secrets.')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'ECS cluster ARN (skips auto-detection)')
  .option('-r, --region <region>', APP_REGION_OPTION_HELP)
  .option('-u, --url <url>', 'Public app URL to health-check (default: the URL the last `sst-laravel deploy` of the stage saved)')
  .option('-p, --path <path>', 'Health path to request', '/up')
  .option('-w, --wait [seconds]', `Keep checking every ${RETRY_SECONDS}s while ECS rolls out, up to this many seconds (default ${DEFAULT_WAIT_SECONDS}). Use it right after a deploy.`)
  .action(async (options: StatusOptions) => {
    try {
      if (!options.stage && !options.cluster) {
        console.error('Error: pass --stage <stage> or --cluster <arn>.');
        process.exit(1);
      }

      const ecsClient = new ECSClient({ region: resolveAppRegion(options.region) });

      const clusterArn = options.cluster
        ? options.cluster
        : await findClusterArn(ecsClient, options.stage as string, undefined);

      console.log(`\nCluster: ${clusterArn.split('/').pop()}`);

      if (!options.url && options.stage) {
        options.url = readSavedAppUrl(process.cwd(), options.stage);

        if (options.url) {
          console.log(`URL: ${options.url} (saved by the last \`sst-laravel deploy\` of ${options.stage})`);
        }
      }

      if (options.url && isLoadBalancerHttpsUrl(options.url)) {
        console.log('Note: the load balancer address only serves http:// until you add a domain. Checking it over https:// will fail.');
      }

      console.log('');

      const waitSeconds = parseWaitSeconds(options.wait);
      const { verdict } = await verifyDeployment({
        ecsClient,
        clusterArns: [clusterArn],
        url: options.url,
        healthPath: options.path,
        waitSeconds,
      });

      console.log('');

      if (verdict === 'healthy') {
        console.log('Deployment looks healthy.');
        return;
      }

      if (verdict === 'in-progress') {
        console.log('ECS is still rolling out. Run again with --wait to keep checking until it finishes.');
      } else if (verdict === 'timed-out') {
        console.log(`Gave up after ${waitSeconds}s: the rollout has not finished.`);
      }

      console.log('Something needs attention. Recent logs: `npx sst-laravel logs web --stage <stage> --no-follow`.');
      process.exit(1);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
