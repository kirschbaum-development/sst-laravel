import { Command } from 'commander';
import { spawn } from 'child_process';
import { validateDeployment } from '../utils/sst-config.js';

export const deployCommand = new Command('deploy')
  .description('Deploy the application using SST')
  .requiredOption('-s, --stage <stage>', 'SST stage name')
  .action(async (options: { stage: string }) => {
    try {
      validateDeployment(options.stage);

      const deployProcess = spawn('npx', ['sst', 'deploy', '--stage', options.stage], {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: true
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
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
