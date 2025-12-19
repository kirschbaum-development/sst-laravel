import { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getTemplatePath } from '../utils/sst-config.js';

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
        shell: true
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

      console.log('\n');
      console.log('\n');
      console.log('Successfully configured sst.config.ts with Laravel boilerplate');
      console.log('You can now customize the configuration for your own Laravel application.');
      console.log('\n');
      console.log('Your default configuration is set to look for a .env.{stage} file when deploying. You can customize this in the sst.config.ts file as needed.');
      console.log('\n');
      console.log('A deploy.sh script has been created with example deployment tasks (migrations, caching, etc.). Customize it as needed.');
      console.log('\n');
      console.log('Run `npx sst deploy --stage {stage}` to deploy your application.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
