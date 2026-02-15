import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { select, confirm } from '@inquirer/prompts';
import { findSstConfig, extractSstProjectName } from '../utils/sst-config.js';
import { pushSecrets, getSecretInfo, getSecretPath, parseEnvFile, needsChunking, listAvailableStages } from '../utils/secrets-manager.js';

export const envPushCommand = new Command('env:push')
  .description('Push environment variables to AWS Secrets Manager')
  .option('-s, --stage <stage>', 'SST stage name')
  .option('-i, --input <file>', 'Input file path (default: .env)')
  .option('-f, --force', 'Push without confirmation')
  .action(async (options: { stage?: string; input?: string; force?: boolean }) => {
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
          console.log('Run this command again with the --stage <stage> flag so the environment file can be created.');
          process.exit(1);
        }

        stage = await select({
          message: 'Select the stage to push to:',
          choices: availableStages.map(s => ({ name: s, value: s })),
        });
      }

      const inputFile = options.input || '.env';
      const inputPath = path.resolve(process.cwd(), inputFile);

      // Check if input file exists
      if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file ${inputFile} not found.`);
        process.exit(1);
      }

      const secretPath = getSecretPath(appName, stage);

      // Parse the .env file
      const content = fs.readFileSync(inputPath, 'utf-8');
      const vars = parseEnvFile(content);
      const varCount = Object.keys(vars).length;

      if (varCount === 0) {
        console.error('Error: No variables found in the input file.');
        process.exit(1);
      }

      console.log(`Found ${varCount} variables in ${inputFile}`);
      console.log(`Target: ${secretPath}`);

      // Check if chunking will be needed
      if (needsChunking(vars)) {
        console.log(`\nNote: Environment file exceeds AWS Secrets Manager limit and will be split into multiple chunks.`);
      }

      // Check if secrets already exist
      const existingInfo = await getSecretInfo(secretPath);

      if (existingInfo && !options.force) {
        if (existingInfo.chunked) {
          console.log(`\nWarning: ${existingInfo.totalKeys} variables already exist at this path (in ${existingInfo.chunks} chunks).`);
        } else {
          console.log(`\nWarning: ${existingInfo.totalKeys} variables already exist at this path.`);
        }

        const shouldOverwrite = await confirm({
          message: 'Do you want to overwrite the existing secrets?',
          default: false,
        });

        if (!shouldOverwrite) {
          console.log('Aborted.');
          process.exit(0);
        }
      }

      // Push secrets to AWS
      console.log('\nPushing secrets to AWS Secrets Manager...');
      const result = await pushSecrets(secretPath, vars);

      if (result.chunked) {
        console.log(`Successfully pushed ${varCount} variables to ${secretPath} (split into ${result.chunks} chunks)`);
      } else {
        console.log(`Successfully pushed ${varCount} variables to ${secretPath}`);
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
