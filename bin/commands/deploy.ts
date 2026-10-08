import { Command } from 'commander';
import { spawn } from 'child_process';
import { validateDeployment, getPackageRoot } from '../utils/sst-config.js';
import { resolveBin } from '../utils/process.js';
import { findAppUrl, findHttpOnlyUrls, readOutputs, saveAppUrl } from '../utils/app-url.js';

export const deployCommand = new Command('deploy')
  .description('Deploy the application using SST')
  .requiredOption('-s, --stage <stage>', 'SST stage name')
  .action(async (options: { stage: string }) => {
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
      console.log(
        `New tasks take a few minutes to pass the health check. Check with: npx sst-laravel status --stage ${options.stage} --wait${url ? '' : ' --url <app-url>'}`,
      );
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
