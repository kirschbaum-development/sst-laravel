#!/usr/bin/env node

import { Command } from 'commander';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, ListClustersCommand, Task } from '@aws-sdk/client-ecs';
import { select } from '@inquirer/prompts';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

interface SshOptions {
  stage?: string;
  cluster?: string;
  region: string;
}

function findSstConfig(): string | null {
  const cwd = process.cwd();
  const possiblePaths = [
    path.join(cwd, 'sst.config.ts'),
    path.join(cwd, 'sst.config.js'),
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

function extractLaravelComponents(configPath: string): string[] {
  const content = fs.readFileSync(configPath, 'utf-8');
  const regex = /new\s+Laravel\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const components: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    components.push(match[1]);
  }

  return components;
}

const program = new Command();

program
  .name('sst-laravel')
  .description('CLI tools for SST Laravel deployments')
  .version(version);

program
  .command('init')
  .description('Initialize a new sst.config.ts file with Laravel boilerplate')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const targetPath = path.join(cwd, 'sst.config.ts');

      if (fs.existsSync(targetPath)) {
        console.error('Warning: sst.config.ts already exists in the current directory.');
        console.error('Will not overwrite existing file.');
        process.exit(1);
      }

      const packageJsonPath = path.join(cwd, 'package.json');
      let packageJson: any = { dependencies: {}, devDependencies: {} };
      let hasPackageJson = false;

      if (fs.existsSync(packageJsonPath)) {
        hasPackageJson = true;
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      }

      const hasSst = packageJson.dependencies?.sst || packageJson.devDependencies?.sst;

      if (!hasSst) {
        console.log('📦 SST not found in project. Installing SST...');
        
        const installProcess = spawn('npm', ['install', '--save-dev', 'sst@latest'], {
          cwd,
          stdio: 'inherit',
          shell: true
        });

        await new Promise<void>((resolve, reject) => {
          installProcess.on('exit', (code) => {
            if (code === 0) {
              console.log('✅ SST installed successfully');
              resolve();
            } else {
              reject(new Error('Failed to install SST'));
            }
          });
          installProcess.on('error', reject);
        });
      } else {
        console.log('✅ SST is already installed');
      }

      const initTemplatePath = path.join(__dirname, '..', '..', 'templates', 'sst.config.init.template');

      if (!fs.existsSync(initTemplatePath)) {
        console.error('Error: Init template file not found.');
        process.exit(1);
      }

      let initTemplateContent = fs.readFileSync(initTemplatePath, 'utf-8');

      const envPath = path.join(cwd, '.env');
      let appName = 'my-laravel-app';

      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const appNameMatch = envContent.match(/^APP_NAME=(.+)$/m);

        if (appNameMatch && appNameMatch[1]) {
          const rawAppName = appNameMatch[1].trim().replace(/^["']|["']$/g, '');
          appName = rawAppName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          console.log(`Using APP_NAME from .env: ${rawAppName}`);
        }
      }

      initTemplateContent = initTemplateContent.replace('my-laravel-app', appName);

      fs.writeFileSync(targetPath, initTemplateContent, 'utf-8');

      console.log('✅ Created initial sst.config.ts');
      console.log('🚀 Running sst install to set up providers...');

      const sstInstallProcess = spawn('npx', ['sst', 'install'], {
        cwd,
        stdio: 'inherit',
        shell: true
      });

      await new Promise<void>((resolve, reject) => {
        sstInstallProcess.on('exit', (code) => {
          if (code === 0) {
            console.log('✅ SST providers installed successfully');
            resolve();
          } else {
            reject(new Error('Failed to run sst install'));
          }
        });
        sstInstallProcess.on('error', reject);
      });

      const runTemplatePath = path.join(__dirname, '..', '..', 'templates', 'sst.config.run.template');

      if (!fs.existsSync(runTemplatePath)) {
        console.error('Error: Run template file not found.');
        process.exit(1);
      }

      const runTemplateContent = fs.readFileSync(runTemplatePath, 'utf-8');

      let finalConfig = fs.readFileSync(targetPath, 'utf-8');
      finalConfig = finalConfig.replace('  async run() {\n  },', `  async run() {\n${runTemplateContent}\n  },`);

      fs.writeFileSync(targetPath, finalConfig, 'utf-8');

      console.log('✅ Successfully configured sst.config.ts with Laravel boilerplate');
      console.log('💡 You can now customize the configuration for your own Laravel application.');
      console.log('🔏 Your default configuration is set to look for a .env.{stage} file when deploying. You can customize this in the sst.config.ts file as needed.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('ssh')
  .description('SSH into a running ECS task')
  .argument('[service]', 'Service to connect to (web, worker, or worker name) - optional')
  .option('-s, --stage <stage>', 'SST stage name (required)')
  .option('-c, --cluster <cluster>', 'ECS cluster name (optional, auto-detected from SST config)')
  .option('-r, --region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .action(async (service: string | undefined, options: SshOptions) => {
    try {
      const region = options.region;
      const stage = options.stage;

      if (!stage) {
        console.error('Error: Stage is required. Use --stage flag to specify the SST stage.');
        process.exit(1);
      }

      const ecsClient = new ECSClient({ region });

      let clusterArn = options.cluster;

      if (!clusterArn) {
        const configPath = findSstConfig();
        if (!configPath) {
          console.error('Error: Could not find sst.config.ts or sst.config.js in current directory.');
          console.error('Please use --cluster flag to specify cluster ARN manually.');
          process.exit(1);
        }

        const components = extractLaravelComponents(configPath);

        if (components.length === 0) {
          console.error('Error: No Laravel components found in SST config.');
          console.error('Please use --cluster flag to specify cluster ARN manually.');
          process.exit(1);
        }

        if (components.length > 1) {
          console.error('Error: Multiple Laravel components found in SST config.');
          console.error(`Found: ${components.join(', ')}`);
          console.error('Please use --cluster flag to specify which cluster to connect to.');
          process.exit(1);
        }

        const componentName = components[0].replace(/-/g, '');
        const clusterPattern = `${stage}-${componentName}Cluster`;

        console.log(`Looking for cluster matching pattern: *${clusterPattern}`);

        const listClustersCommand = new ListClustersCommand({});
        const listClustersResponse = await ecsClient.send(listClustersCommand);

        if (!listClustersResponse.clusterArns || listClustersResponse.clusterArns.length === 0) {
          console.error('Error: No ECS clusters found in this region.');
          process.exit(1);
        }

        const matchingCluster = listClustersResponse.clusterArns.find(arn => {
          const clusterName = arn.split('/').pop();
          return clusterName?.includes(stage) && clusterName?.includes(componentName);
        });

        if (!matchingCluster) {
          console.error(`Error: No cluster found matching stage "${stage}" and component "${components[0]}".`);
          console.error('Available clusters:');
          listClustersResponse.clusterArns.forEach(arn => {
            console.error(`  - ${arn.split('/').pop()}`);
          });
          process.exit(1);
        }

        clusterArn = matchingCluster;
        console.log(`Auto-detected cluster: ${clusterArn.split('/').pop()}`);
      }

      console.log(`Cluster ARN: ${clusterArn}`);

      const listTasksCommand = new ListTasksCommand({
        cluster: clusterArn,
        desiredStatus: 'RUNNING'
      });

      const listTasksResponse = await ecsClient.send(listTasksCommand);

      if (!listTasksResponse.taskArns || listTasksResponse.taskArns.length === 0) {
        console.error('No running tasks found in cluster');
        process.exit(1);
      }

      const describeTasksCommand = new DescribeTasksCommand({
        cluster: clusterArn,
        tasks: listTasksResponse.taskArns
      });

      const describeTasksResponse = await ecsClient.send(describeTasksCommand);

      let matchingTask: Task | undefined;

      if (service) {
        let servicePrefix: string;
        if (service === 'web') {
          servicePrefix = '-web';
        } else if (service === 'worker') {
          servicePrefix = '-worker';
        } else {
          servicePrefix = `-${service}`;
        }

        matchingTask = describeTasksResponse.tasks?.find(task => {
          const containerName = task.containers?.[0]?.name || '';
          return containerName.toLowerCase().includes(servicePrefix.toLowerCase());
        });
      }

      if (!matchingTask) {
        if (service) {
          console.log(`\nNo running task found matching service: ${service}`);
        }
        console.log('Available tasks in cluster:\n');

        const choices = describeTasksResponse.tasks?.map(task => {
          const taskId = task.taskArn?.split('/').pop() || '';
          const containerName = task.containers?.[0]?.name || 'unknown';
          const status = task.lastStatus || 'unknown';

          return {
            name: `${containerName} (${taskId.substring(0, 8)}...) - ${status}`,
            value: task,
            description: `Task: ${taskId}`
          };
        }) || [];

        if (choices.length === 0) {
          console.error('No tasks available to select from.');
          process.exit(1);
        }

        matchingTask = await select({
          message: 'Select a task to connect to:',
          choices
        });
      }

      const taskId = matchingTask.taskArn?.split('/').pop();

      console.log(`Connecting to task: ${taskId}`);

      const awsCommand = spawn('aws', [
        'ecs',
        'execute-command',
        '--cluster', clusterArn,
        '--task', taskId!,
        '--container', matchingTask.containers?.[0]?.name || '',
        '--interactive',
        '--command', '/bin/bash'
      ], {
        stdio: 'inherit',
        env: { ...process.env, AWS_REGION: region }
      });

      awsCommand.on('exit', (code) => {
        process.exit(code || 0);
      });

    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
