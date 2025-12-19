#!/usr/bin/env node

import { Command } from 'commander';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, ListClustersCommand, DescribeTaskDefinitionCommand, Task } from '@aws-sdk/client-ecs';
import {
  IAMClient,
  CreateOpenIDConnectProviderCommand,
  ListOpenIDConnectProvidersCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  GetRoleCommand
} from '@aws-sdk/client-iam';
import { select } from '@inquirer/prompts';
import { spawn, execSync } from 'child_process';
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

interface LogsOptions {
  stage?: string;
  cluster?: string;
  region: string;
  follow: boolean;
  since?: string;
}

interface GithubIamOptions {
  repo?: string;
  branch: string;
  region: string;
  roleName: string;
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
  const regex = /new\s+LaravelService\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const components: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    components.push(match[1]);
  }

  return components;
}

function extractEnvironmentFile(configPath: string, stage: string): string | null {
  const content = fs.readFileSync(configPath, 'utf-8');

  // Find the start of environment block
  const envMatch = content.match(/\benvironment\s*:\s*\{/);
  if (!envMatch || envMatch.index === undefined) {
    return null;
  }

  // Extract the environment block by counting braces
  const startIndex = envMatch.index + envMatch[0].length;
  let braceCount = 1;
  let endIndex = startIndex;

  for (let i = startIndex; i < content.length && braceCount > 0; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') braceCount--;
    endIndex = i;
  }

  const envBlock = content.substring(startIndex, endIndex);

  // Now find the file property within the environment block
  const fileMatch = envBlock.match(/\bfile\s*:\s*[`'"]([^`'"]+)[`'"]/);

  if (!fileMatch) {
    return null;
  }

  let envFile = fileMatch[1];

  // Replace ${$app.stage} with actual stage value
  envFile = envFile.replace(/\$\{?\$app\.stage\}?/g, stage);

  return envFile;
}

function detectGitHubRepo(): string | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, '')}`;
    }

    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return `${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, '')}`;
    }

    return null;
  } catch {
    return null;
  }
}

function validateDeployment(stage: string): void {
  const configPath = findSstConfig();

  if (!configPath) {
    throw new Error('Could not find sst.config.ts or sst.config.js in current directory.');
  }

  const envFile = extractEnvironmentFile(configPath, stage);

  if (envFile) {
    const cwd = process.cwd();
    const envFilePath = path.join(cwd, envFile);

    if (!fs.existsSync(envFilePath)) {
      throw new Error(`Environment file "${envFile}" not found. Please create the file or update your sst.config.ts configuration.`);
    }
  }
}

const program = new Command();

program
  .name('sst-laravel')
  .description('CLI tools for SST Laravel deployments')
  .version(version);

program
  .command('init')
  .description('Initialize SST and SST Laravel, creating a new sst.config.ts file to deploy your Laravel application')
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

      const deployTemplatePath = path.join(__dirname, '..', '..', 'templates', 'deploy.template');

      if (fs.existsSync(deployTemplatePath)) {
        const infraDir = path.join(cwd, 'infra');
        if (!fs.existsSync(infraDir)) {
          fs.mkdirSync(infraDir, { recursive: true });
        }

        const deployScriptPath = path.join(infraDir, 'deploy.sh');
        const deployTemplateContent = fs.readFileSync(deployTemplatePath, 'utf-8');
        fs.writeFileSync(deployScriptPath, deployTemplateContent, 'utf-8');
        fs.chmodSync(deployScriptPath, 0o755);
        console.log('✅ Created infra/deploy.sh script');
      }

      console.log('\n');
      console.log('\n');
      console.log('✅ Successfully configured sst.config.ts with Laravel boilerplate');
      console.log('💡 You can now customize the configuration for your own Laravel application.');
      console.log('\n');
      console.log('🔏🔏🔏 Your default configuration is set to look for a .env.{stage} file when deploying. You can customize this in the sst.config.ts file as needed.');
      console.log('\n');
      console.log('📝📝📝 A deploy.sh script has been created with example deployment tasks (migrations, caching, etc.). Customize it as needed.');
      console.log('\n');
      console.log('🚀🚀🚀 Run `npx sst deploy --stage {stage}` to deploy your application.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('deploy')
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

program
  .command('logs')
  .description('Stream CloudWatch logs from a running ECS task')
  .argument('[service]', 'Service to stream logs from (web, worker, or worker name) - optional')
  .option('-s, --stage <stage>', 'SST stage name (required)')
  .option('-c, --cluster <cluster>', 'ECS cluster name (optional, auto-detected from SST config)')
  .option('-r, --region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .option('-f, --follow', 'Follow log output (like tail -f)', true)
  .option('--since <time>', 'Start time for logs (e.g., 5m, 1h, 2d)', '10m')
  .action(async (service: string | undefined, options: LogsOptions) => {
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
          message: 'Select a task to stream logs from:',
          choices
        });
      }

      const taskDefinitionArn = matchingTask.taskDefinitionArn;

      if (!taskDefinitionArn) {
        console.error('Error: Could not find task definition ARN');
        process.exit(1);
      }

      const describeTaskDefCommand = new DescribeTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn
      });

      const taskDefResponse = await ecsClient.send(describeTaskDefCommand);
      const containerDef = taskDefResponse.taskDefinition?.containerDefinitions?.[0];
      const logConfig = containerDef?.logConfiguration;

      if (!logConfig || logConfig.logDriver !== 'awslogs') {
        console.error('Error: Task does not use CloudWatch Logs (awslogs driver)');
        process.exit(1);
      }

      const logGroup = logConfig.options?.['awslogs-group'];

      if (!logGroup) {
        console.error('Error: Could not determine CloudWatch log group');
        process.exit(1);
      }

      const containerName = matchingTask.containers?.[0]?.name || 'unknown';
      console.log(`Streaming logs from: ${containerName}`);
      console.log(`Log group: ${logGroup}`);
      console.log('');

      const awsArgs = [
        'logs',
        'tail',
        logGroup,
        '--since', options.since || '10m'
      ];

      if (options.follow) {
        awsArgs.push('--follow');
      }

      const awsCommand = spawn('aws', awsArgs, {
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

program
  .command('github-iam')
  .description('Create an IAM Role on AWS for GitHub Actions OIDC authentication for deployments')
  .option('-r, --repo <repo>', 'GitHub repository in format owner/repo (auto-detected from git remote)')
  .option('-b, --branch <branch>', 'Branch to allow deployments from (use * for all branches)', '*')
  .option('--region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .option('--role-name <name>', 'Name for the IAM role', 'github-actions-sst-deploy')
  .action(async (options: GithubIamOptions) => {
    try {
      const { branch, region, roleName } = options;
      let repo = options.repo;

      if (!repo) {
        const detectedRepo = detectGitHubRepo();
        if (detectedRepo) {
          repo = detectedRepo;
          console.log(`📦 Auto-detected repository: ${repo}`);
        } else {
          console.error('Error: Could not auto-detect GitHub repository.');
          console.error('Please use --repo flag to specify the repository in format owner/repo');
          process.exit(1);
        }
      }

      if (!repo.includes('/')) {
        console.error('Error: Repository must be in format owner/repo');
        process.exit(1);
      }

      const [owner, repoName] = repo.split('/');
      const iamClient = new IAMClient({ region });

      const githubOidcUrl = 'https://token.actions.githubusercontent.com';
      const githubOidcArn = `arn:aws:iam::${await getAwsAccountId(iamClient)}:oidc-provider/token.actions.githubusercontent.com`;

      console.log(`\n🔧 Setting up GitHub Actions OIDC for ${owner}/${repoName}...\n`);

      const oidcProviderArn = await ensureGithubOidcProvider(iamClient, githubOidcUrl);
      console.log(`✅ GitHub OIDC Provider: ${oidcProviderArn}`);

      const trustPolicy = buildTrustPolicy(oidcProviderArn, owner, repoName, branch);

      try {
        const existingRole = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
        console.log(`⚠️  Role "${roleName}" already exists with ARN: ${existingRole.Role?.Arn}`);
        console.log('   If you need to update the trust policy, delete the role first and re-run this command.');
      } catch (error: any) {
        if (error.name === 'NoSuchEntityException') {
          const createRoleResponse = await iamClient.send(new CreateRoleCommand({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
            Description: `GitHub Actions deployment role for ${owner}/${repoName}`
          }));

          console.log(`✅ Created IAM Role: ${createRoleResponse.Role?.Arn}`);

          await iamClient.send(new AttachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess'
          }));

          console.log('✅ Attached AdministratorAccess policy');
        } else {
          throw error;
        }
      }

      console.log('\n📋 Add the following to your GitHub Actions workflow:\n');
      console.log('```yaml');
      console.log('permissions:');
      console.log('  id-token: write');
      console.log('  contents: read');
      console.log('');
      console.log('jobs:');
      console.log('  deploy:');
      console.log('    runs-on: ubuntu-latest');
      console.log('    steps:');
      console.log('      - uses: actions/checkout@v4');
      console.log('');
      console.log('      - name: Configure AWS Credentials');
      console.log('        uses: aws-actions/configure-aws-credentials@v4');
      console.log('        with:');
      console.log(`          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/${roleName}`);
      console.log(`          aws-region: ${region}`);
      console.log('');
      console.log('      - name: Deploy with SST');
      console.log('        run: npx sst deploy --stage production');
      console.log('```\n');

      console.log('💡 Replace ACCOUNT_ID with your AWS account ID in the workflow file.');
      console.log(`💡 The role allows deployments from: ${branch === '*' ? 'all branches' : `branch "${branch}"`}`);

    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

async function getAwsAccountId(iamClient: IAMClient): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const stsClient = new STSClient({ region: iamClient.config.region });
  const response = await stsClient.send(new GetCallerIdentityCommand({}));
  return response.Account!;
}

async function ensureGithubOidcProvider(iamClient: IAMClient, githubOidcUrl: string): Promise<string> {
  const listResponse = await iamClient.send(new ListOpenIDConnectProvidersCommand({}));

  const existingProvider = listResponse.OpenIDConnectProviderList?.find(
    provider => provider.Arn?.includes('token.actions.githubusercontent.com')
  );

  if (existingProvider) {
    return existingProvider.Arn!;
  }

  const thumbprint = '6938fd4d98bab03faadb97b34396831e3780aea1';

  const createResponse = await iamClient.send(new CreateOpenIDConnectProviderCommand({
    Url: githubOidcUrl,
    ClientIDList: ['sts.amazonaws.com'],
    ThumbprintList: [thumbprint]
  }));

  return createResponse.OpenIDConnectProviderArn!;
}

function buildTrustPolicy(oidcProviderArn: string, owner: string, repo: string, branch: string): object {
  const condition = branch === '*'
    ? `repo:${owner}/${repo}:*`
    : `repo:${owner}/${repo}:ref:refs/heads/${branch}`;

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Federated: oidcProviderArn
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': condition
          }
        }
      }
    ]
  };
}

program.parse();
