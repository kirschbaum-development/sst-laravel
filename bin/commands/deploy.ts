import { Command } from 'commander';
import { spawn } from 'child_process';
import { ECSClient } from '@aws-sdk/client-ecs';
import { validateDeployment, getPackageRoot, resolveAppRegion } from '../utils/sst-config.js';
import { resolveBin } from '../utils/process.js';
import { findAppUrl, findHttpOnlyUrls, readOutputs, saveAppUrl } from '../utils/app-url.js';
import { APP_REGION_OPTION_HELP } from '../utils/aws.js';
import { findStageClusters } from '../utils/ecs.js';
import { DEFAULT_WAIT_SECONDS, DeploymentVerdict, verifyDeployment } from '../utils/deployment-check.js';

interface DeployOptions {
  stage: string;
  wait: boolean;
  timeout?: string;
  path: string;
  region?: string;
}

export const parseTimeoutSeconds = (timeout: string | undefined): number => {
  const seconds = timeout === undefined ? NaN : parseInt(timeout, 10);
  return Number.isNaN(seconds) || seconds <= 0 ? DEFAULT_WAIT_SECONDS : seconds;
};

export const deployCommand = new Command('deploy')
  .description('Deploy the application using SST, then wait until every service runs the new revision. Fails when ECS rolls the deployment back.')
  .requiredOption('-s, --stage <stage>', 'SST stage name')
  .option('--no-wait', 'Return when `sst deploy` finishes, without waiting for ECS to roll out the new revision')
  .option('-t, --timeout <seconds>', `How long to wait for the rollout (default ${DEFAULT_WAIT_SECONDS})`)
  .option('-p, --path <path>', 'Health path to request once the rollout is live', '/up')
  .option('-r, --region <region>', APP_REGION_OPTION_HELP)
  .action(async (options: DeployOptions) => {
    try {
      validateDeployment(options.stage);

      const deployProcess = spawn(resolveBin('npx'), ['sst', 'deploy', '--stage', options.stage], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          SST_LARAVEL_PACKAGE_ROOT: getPackageRoot(),
        },
      });

      await new Promise<void>((resolve, reject) => {
        deployProcess.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Deploy failed with exit code ${code}`));
          }
        });
        deployProcess.on('error', reject);
      });

      const outputs = readOutputs(process.cwd());
      const url = findAppUrl(outputs);
      const httpOnlyUrl = findHttpOnlyUrls(outputs)[0];

      // `status` checks this URL when it gets no --url.
      saveAppUrl(process.cwd(), options.stage, url);

      console.log('');
      if (httpOnlyUrl) {
        console.log(`The app runs on the load balancer address over http only: ${httpOnlyUrl}`);
        console.log('https:// will not work until you add a domain (web.domain in sst.config.ts).');
      }

      const statusCommand = `npx sst-laravel status --stage ${options.stage} --wait${url ? '' : ' --url <app-url>'}`;

      if (!options.wait) {
        console.log(`Not waiting for ECS to roll out the new revision. Check it with: ${statusCommand}`);
        return;
      }

      // `sst deploy` returns once ECS accepts the new revision. ECS then
      // replaces the tasks, and rolls back when the new ones fail.
      console.log('Waiting for ECS to roll out the new revision. New tasks take a few minutes to pass their health checks.\n');

      const timeoutSeconds = parseTimeoutSeconds(options.timeout);
      let verdict: DeploymentVerdict;

      try {
        const ecsClient = new ECSClient({ region: resolveAppRegion(options.region) });
        const clusters = await findStageClusters(ecsClient, options.stage);

        ({ verdict } = await verifyDeployment({
          ecsClient,
          clusterArns: clusters.map((cluster) => cluster.clusterArn),
          url,
          healthPath: options.path,
          waitSeconds: timeoutSeconds,
        }));
      } catch (error) {
        console.error(`\n\`sst deploy\` finished, but the rollout could not be checked: ${(error as Error).message}`);
        console.error(`Check it with \`${statusCommand}\`, or pass --no-wait to skip the check.`);
        process.exit(1);
      }

      console.log('');

      if (verdict === 'healthy') {
        console.log('Deployed: every service runs the new revision.');
        return;
      }

      if (verdict === 'timed-out') {
        console.error(`The rollout did not finish within ${timeoutSeconds}s. Check it with: ${statusCommand}`);
      } else {
        console.error(
          `\`sst deploy\` finished, but the new revision is not healthy (see above). Recent logs: \`npx sst-laravel logs <web|reverb|worker name> --stage ${options.stage} --no-follow\`.`,
        );
      }

      process.exit(1);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
