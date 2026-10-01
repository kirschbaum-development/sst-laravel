import { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { validateDeployment, getPackageRoot } from '../utils/sst-config.js';
import { resolveBin } from '../utils/process.js';

/**
 * The app URLs from the outputs SST writes after a deploy. Only the plain
 * http load balancer addresses are returned: those are the ones that need
 * the "no https yet" note.
 */
export const findHttpOnlyUrls = (outputs: Record<string, unknown>): string[] =>
  Object.values(outputs).filter(
    (value): value is string =>
      typeof value === 'string' && /^http:\/\/[^/]*\.elb\.amazonaws\.com/.test(value),
  );

const readOutputs = (cwd: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.sst', 'outputs.json'), 'utf-8'));
  } catch {
    return {};
  }
};

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

      const httpOnlyUrls = findHttpOnlyUrls(readOutputs(process.cwd()));
      const url = httpOnlyUrls[0];

      console.log('');
      if (url) {
        console.log(`The app runs on the load balancer address over http only: ${url}`);
        console.log('https:// will not work until you add a domain (web.domain in sst.config.ts).');
      }
      console.log(
        `New tasks take a few minutes to pass the health check. Check with: npx sst-laravel status --stage ${options.stage} --wait${url ? ` --url ${url}` : ' --url <app-url>'}`,
      );
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
