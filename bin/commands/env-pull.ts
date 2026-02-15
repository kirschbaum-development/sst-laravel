import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { select, confirm } from '@inquirer/prompts';
import { findSstConfig, extractSstProjectName } from '../utils/sst-config.js';
import { pullSecrets, getSecretPath, getSecretInfo, toEnvFileContent, listAvailableStages } from '../utils/secrets-manager.js';

export const envPullCommand = new Command('env:pull')
  .description('Pull environment variables from AWS Secrets Manager')
  .option('-s, --stage <stage>', 'SST stage name')
  .option('-o, --output <file>', 'Output file path (default: .env.{stage})')
  .option('-f, --force', 'Overwrite existing file without confirmation')
  .action(async (options: { stage?: string; output?: string; force?: boolean }) => {
    try {
      const configPath = findSstConfig();

      if (!configPath) {
        console.error('Error: Could not find sst.config.ts or sst.config.js in current directory.');
        process.exit(1);
      }

      const appName = extractSstProjectName(configPath);

      if (!appName) {
        console.error('Error: Could not extract app name from SST config.');
        process.exit(1);
      }

      // Determine stage
      let stage = options.stage;
      if (!stage) {
        const availableStages = await listAvailableStages(appName);

        if (availableStages.length === 0) {
          console.log('No stages found in AWS Secrets Manager for this app.');
          console.log('Run this command again with the --stage <stage> flag to create the environment file.');
          process.exit(1);
        }

        stage = await select({
          message: 'Select the stage to pull from:',
          choices: availableStages.map(s => ({ name: s, value: s })),
        });
      }

      const secretPath = getSecretPath(appName, stage);
      const outputFile = options.output || `.env.${stage}`;
      const outputPath = path.resolve(process.cwd(), outputFile);

      console.log(`Pulling environment variables from: ${secretPath}`);

      // Get info about the secret structure
      const secretInfo = await getSecretInfo(secretPath);

      if (!secretInfo) {
        console.error(`Error: No secrets found at ${secretPath}`);
        console.log('');
        console.log('To create secrets for this environment, run:');
        console.log(`  sst-laravel env:push --stage ${stage} --input .env.example`);
        process.exit(1);
      }

      if (secretInfo.chunked) {
        console.log(`Found ${secretInfo.totalKeys} variables in ${secretInfo.chunks} chunks`);
      }

      // Check if output file exists
      if (fs.existsSync(outputPath) && !options.force) {
        const shouldOverwrite = await confirm({
          message: `File ${outputFile} already exists. Overwrite?`,
          default: false,
        });

        if (!shouldOverwrite) {
          console.log('Aborted.');
          process.exit(0);
        }
      }

      // Pull secrets from AWS
      const secrets = await pullSecrets(secretPath);

      if (!secrets) {
        console.error(`Error: Failed to pull secrets from ${secretPath}`);
        process.exit(1);
      }

      // Convert to .env format and write
      const envContent = toEnvFileContent(secrets);
      fs.writeFileSync(outputPath, envContent + '\n');

      console.log(`Successfully pulled ${Object.keys(secrets).length} variables to ${outputFile}`);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
