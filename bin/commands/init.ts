import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { confirm } from '@inquirer/prompts';
import { getTemplatePath, getPackageRoot } from '../utils/sst-config.js';

const SKILL_FILE_PATH = fileURLToPath(new URL('../../skills/laravel-initial-setup/SKILL.md', import.meta.url));

const runProcess = (command: string, args: string[], cwd: string) => {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
};

const detectLaravelBoostVersion = (cwd: string): string | null => {
  try {
    const output = execSync('composer show laravel/boost --no-ansi --no-interaction', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString();

    const versionMatch = output.match(/versions?\s*:\s*\*?\s*v?([0-9][^\s]*)/i);
    if (!versionMatch) {
      return null;
    }

    return versionMatch[1].replace(/^v/, '');
  } catch (error) {
    return null;
  }
};

const isVersionAtLeast = (version: string, minimum: string) => {
  const normalize = (input: string) => input.split('.').map((segment) => parseInt(segment, 10) || 0);
  const versionParts = normalize(version);
  const minParts = normalize(minimum);

  for (let i = 0; i < Math.max(versionParts.length, minParts.length); i++) {
    const current = versionParts[i] ?? 0;
    const min = minParts[i] ?? 0;

    if (current > min) return true;
    if (current < min) return false;
  }

  return true;
};

const installSkillWithBoost = async (cwd: string) => {
  const aiSkillsDir = path.join(cwd, '.ai', 'skills', 'sst-laravel-initial-setup');
  fs.mkdirSync(aiSkillsDir, { recursive: true });

  const targetPath = path.join(aiSkillsDir, 'SKILL.md');
  fs.copyFileSync(SKILL_FILE_PATH, targetPath);

  console.log(`Copied skill file to ${path.relative(cwd, targetPath)}`);
  console.log('Running boost:update to refresh Laravel Boost skills...');
  await runProcess('php', ['artisan', 'boost:update'], cwd);
};

const installSkillViaNpx = async (cwd: string) => {
  console.log('Installing skill via `npx skills add`...');
  await runProcess('npx', ['skills', 'add', SKILL_FILE_PATH], cwd);
};

const maybeInstallSkill = async (cwd: string) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Skipping AI skill installation prompt (non-interactive terminal).');
    return;
  }

  const shouldInstallSkill = await confirm({
    message: 'Install the SST Laravel Initial Setup AI skill in this project?',
    default: true
  });

  if (!shouldInstallSkill) {
    console.log('Skipping AI skill installation. You can add it later from skills/laravel-initial-setup.');
    return;
  }

  const boostVersion = detectLaravelBoostVersion(cwd);

  if (boostVersion) {
    console.log(`Detected laravel/boost version ${boostVersion}`);
  } else {
    console.log('laravel/boost package not detected or Composer unavailable.');
  }

  if (boostVersion && isVersionAtLeast(boostVersion, '2.0.0')) {
    await installSkillWithBoost(cwd);
  } else {
    if (boostVersion) {
      console.log('laravel/boost version is below 2.0. Falling back to npx skills.');
    }
    await installSkillViaNpx(cwd);
  }

  console.log('\n');
  console.log('\n');
  console.log('🤖 SST Laravel skill installed successfully');
  console.log('Run "Please help me set up the deployment config of my application using SST Laravel" in your AI agent to get started');
};

export const initCommand = new Command('init')
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

      if (fs.existsSync(packageJsonPath)) {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      }

      const hasSst = packageJson.dependencies?.sst || packageJson.devDependencies?.sst;

      if (!hasSst) {
        console.log('SST not found in project. Installing SST...');

        const installProcess = spawn('npm', ['install', '--save-dev', 'sst@latest'], {
          cwd,
          stdio: 'inherit',
          shell: true
        });

        await new Promise<void>((resolve, reject) => {
          installProcess.on('exit', (code) => {
            if (code === 0) {
              console.log('SST installed successfully');
              resolve();
            } else {
              reject(new Error('Failed to install SST'));
            }
          });
          installProcess.on('error', reject);
        });
      } else {
        console.log('SST is already installed');
      }

      const initTemplatePath = getTemplatePath('sst.config.init.template');

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

      console.log('Created initial sst.config.ts');
      console.log('Running sst install to set up providers...');

      const sstInstallProcess = spawn('npx', ['sst', 'install'], {
        cwd,
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          SST_LARAVEL_PACKAGE_ROOT: getPackageRoot(),
        },
      });

      await new Promise<void>((resolve, reject) => {
        sstInstallProcess.on('exit', (code) => {
          if (code === 0) {
            console.log('SST providers installed successfully');
            resolve();
          } else {
            reject(new Error('Failed to run sst install'));
          }
        });
        sstInstallProcess.on('error', reject);
      });

      const runTemplatePath = getTemplatePath('sst.config.run.template');

      if (!fs.existsSync(runTemplatePath)) {
        console.error('Error: Run template file not found.');
        process.exit(1);
      }

      const runTemplateContent = fs.readFileSync(runTemplatePath, 'utf-8');

      let finalConfig = fs.readFileSync(targetPath, 'utf-8');
      finalConfig = finalConfig.replace('  async run() {\n  },', `  async run() {\n${runTemplateContent}\n  },`);

      fs.writeFileSync(targetPath, finalConfig, 'utf-8');

      const deployTemplatePath = getTemplatePath('deploy.template');

      if (fs.existsSync(deployTemplatePath)) {
        const infraDir = path.join(cwd, 'infra');
        if (!fs.existsSync(infraDir)) {
          fs.mkdirSync(infraDir, { recursive: true });
        }

        const deployScriptPath = path.join(infraDir, 'deploy.sh');
        const deployTemplateContent = fs.readFileSync(deployTemplatePath, 'utf-8');
        fs.writeFileSync(deployScriptPath, deployTemplateContent, 'utf-8');
        fs.chmodSync(deployScriptPath, 0o755);
        console.log('Created infra/deploy.sh script');
      }

      try {
        await maybeInstallSkill(cwd);
      } catch (skillError) {
        console.warn('Failed to install AI skill automatically:', (skillError as Error).message);
        console.warn('You can manually add it later from skills/laravel-initial-setup.');
      }

      console.log('\n');
      console.log('\n');
      console.log('✅ Successfully configured sst.config.ts with Laravel boilerplate');
      console.log('You can now customize the configuration for your own Laravel application.');
      console.log('\n');
      console.log('Your default configuration is set to look for a .env.{stage} file when deploying. You can customize this in the sst.config.ts file as needed.');
      console.log('\n');
      console.log('A deploy.sh script has been created with example deployment tasks (migrations, caching, etc.). Customize it as needed.');
      console.log('\n');
      console.log('Run `npx sst-laravel deploy --stage {stage}` to deploy your application.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
