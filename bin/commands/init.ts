import { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';
import { getTemplatePath, getPackageRoot } from '../utils/sst-config.js';
import { resolveBin, runProcess } from '../utils/process.js';
import { installSkill } from '../utils/skill.js';
import { ensureGitIgnore, resolveAppName, resolvePhpVersion } from '../utils/project.js';

const PACKAGE_NAME = '@kirschbaum-development/sst-laravel';

const maybeInstallSkill = async (cwd: string) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Skipping AI skill installation prompt (non-interactive terminal).');
    return;
  }

  const shouldInstallSkill = await confirm({
    message: 'Install the SST Laravel deployment skill in this project?',
    default: true
  });

  if (!shouldInstallSkill) {
    console.log('Skipping AI skill installation. Run `npx sst-laravel skill:install` to add it later.');
    return;
  }

  await installSkill(cwd);

  console.log('\n');
  console.log('\n');
  console.log('🤖 SST Laravel skill installed successfully');
  console.log('Run "Use the sst-laravel skill to set up and deploy this application. Continue until the /up endpoint is healthy." in your AI agent to get started');
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

        const installProcess = spawn(resolveBin('npm'), ['install', '--save-dev', 'sst@^4.17.1'], {
          cwd,
          stdio: 'inherit'
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

      // sst.config.ts imports this package, so it must be installed in the
      // project even when `init` runs through `npx -y`.
      const hasSstLaravel =
        packageJson.dependencies?.[PACKAGE_NAME] || packageJson.devDependencies?.[PACKAGE_NAME];

      if (!hasSstLaravel) {
        const { version } = JSON.parse(
          fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'),
        );

        console.log('SST Laravel not found in project. Installing SST Laravel...');
        await runProcess('npm', ['install', '--save', `${PACKAGE_NAME}@^${version}`], cwd);
        console.log('SST Laravel installed successfully');
      }

      const initTemplatePath = getTemplatePath('sst.config.init.template');

      if (!fs.existsSync(initTemplatePath)) {
        console.error('Error: Init template file not found.');
        process.exit(1);
      }

      let initTemplateContent = fs.readFileSync(initTemplatePath, 'utf-8');

      const app = resolveAppName(cwd);
      const appName = app.name;

      console.log(`Using app name "${appName}" (from ${app.source}).`);
      if (app.generic) {
        console.warn(
          `Warning: "${appName}" is a generic name. SST keys its state by app name and stage, so another project with the same name deploying to this AWS account would overwrite it. Change \`name\` in sst.config.ts to something unique.`,
        );
      }

      initTemplateContent = initTemplateContent.replace('my-laravel-app', appName);

      fs.writeFileSync(targetPath, initTemplateContent, 'utf-8');

      console.log('Created initial sst.config.ts');
      console.log('Running sst install to set up providers...');

      const sstInstallProcess = spawn(resolveBin('npx'), ['sst', 'install'], {
        cwd,
        stdio: 'inherit',
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

      // The image copies the local vendor folder, so it needs the PHP it was installed with.
      const phpVersion = resolvePhpVersion();
      const runTemplateContent = fs
        .readFileSync(runTemplatePath, 'utf-8')
        .replace('php: 8.4,', `php: ${phpVersion},`);
      console.log(`Containers will run PHP ${phpVersion}.`);

      let finalConfig = fs.readFileSync(targetPath, 'utf-8');
      finalConfig = finalConfig.replace('  async run() {\n  },', `  async run() {\n${runTemplateContent}\n  },`);

      fs.writeFileSync(targetPath, finalConfig, 'utf-8');

      const ignored = ensureGitIgnore(cwd, ['.sst']);
      if (ignored.length > 0) {
        console.log(`Added ${ignored.join(', ')} to .gitignore`);
      }

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
        console.warn('Run `npx sst-laravel skill:install` to add it later.');
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
