import { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { validateDeployment, findSstConfig, extractSstProjectName, extractSecretsConfig, getPackageRoot } from '../utils/sst-config.js';
import { pullSecrets, getSecretPath, getSecretInfo, toEnvFileContent } from '../utils/secrets-manager.js';

export const deployCommand = new Command('deploy')
  .description('Deploy the application using SST')
  .requiredOption('-s, --stage <stage>', 'SST stage name')
  .action(async (options: { stage: string }) => {
    try {
      validateDeployment(options.stage);

      const configPath = findSstConfig();
      if (configPath) {
        const appName = extractSstProjectName(configPath);
        const secretsConfig = extractSecretsConfig(configPath);

        if (appName && secretsConfig) {
          console.log('RemoteEnvVault detected, fetching secrets from AWS Secrets Manager...');

          // Determine the secret path
          const secretPath = secretsConfig.path || getSecretPath(appName, options.stage);

          try {
            // Get info about the secret structure first
            const secretInfo = await getSecretInfo(secretPath);

            if (!secretInfo) {
              console.warn(`Warning: No secrets found at ${secretPath}`);
              console.log('Continuing with deployment without secrets...');
            } else {
              if (secretInfo.chunked) {
                console.log(`Found ${secretInfo.totalKeys} variables in ${secretInfo.chunks} chunks`);
              }

              const secrets = await pullSecrets(secretPath);

              if (secrets) {
                // Ensure the .sst/laravel/deploy directory exists
                const deployDir = path.join(process.cwd(), '.sst', 'laravel', 'deploy');
                fs.mkdirSync(deployDir, { recursive: true });

                // Write secrets to .env file
                const envFilePath = path.join(deployDir, '.env');
                const envContent = toEnvFileContent(secrets);
                fs.writeFileSync(envFilePath, envContent + '\n');
                fs.chmodSync(envFilePath, 0o755);

                console.log(`Fetched ${Object.keys(secrets).length} variables from ${secretPath}`);
              }
            }
          } catch (error) {
            console.error(`Warning: Failed to fetch secrets from ${secretPath}:`, (error as Error).message);
            console.log('Continuing with deployment without secrets...');
          }
        }
      }

      const deployProcess = spawn('npx', ['sst', 'deploy', '--stage', options.stage], {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: true,
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
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
