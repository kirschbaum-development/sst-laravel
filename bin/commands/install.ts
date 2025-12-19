import { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findSstConfig } from '../utils/sst-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const installCommand = new Command('install')
  .description('Run SST install, handling existing .sst folder by temporarily renaming sst.config.ts')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const sstFolder = path.join(cwd, '.sst');
      const configPath = findSstConfig();

      const sstFolderExists = fs.existsSync(sstFolder);

      let backupPath: string | null = null;
      let tempConfigPath: string | null = null;

      if (sstFolderExists && configPath) {
        backupPath = `${configPath}.bkp`;
        tempConfigPath = path.join(cwd, 'sst.config.ts');

        console.log('.sst folder exists, temporarily renaming sst.config.ts...');
        fs.renameSync(configPath, backupPath);

        // Create temporary sst.config.ts from template
        const templatePath = path.join(__dirname, '..', '..', 'templates', 'sst.config.init.template');
        if (fs.existsSync(templatePath)) {
          const templateContent = fs.readFileSync(templatePath, 'utf-8');
          fs.writeFileSync(tempConfigPath, templateContent, 'utf-8');
          console.log('Created temporary sst.config.ts from template');
        } else {
          throw new Error('Template file not found: sst.config.init.template');
        }
      }

      console.log('Running sst install...');

      const installProcess = spawn('npx', ['sst', 'install'], {
        cwd,
        stdio: 'inherit',
        shell: true
      });

      await new Promise<void>((resolve, reject) => {
        installProcess.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`sst install failed with exit code ${code}`));
          }
        });
        installProcess.on('error', reject);
      });

      if (backupPath && configPath) {
        // Remove temporary config file
        if (tempConfigPath && fs.existsSync(tempConfigPath)) {
          fs.unlinkSync(tempConfigPath);
          console.log('Removed temporary sst.config.ts');
        }

        console.log('Restoring sst.config.ts...');
        fs.renameSync(backupPath, configPath);
      }

      console.log('SST install completed successfully');
    } catch (error) {
      // Try to restore backup if something went wrong
      const cwd = process.cwd();
      const possibleBackups = [
        path.join(cwd, 'sst.config.ts.bkp'),
        path.join(cwd, 'sst.config.js.bkp'),
      ];

      for (const backupPath of possibleBackups) {
        if (fs.existsSync(backupPath)) {
          const originalPath = backupPath.replace('.bkp', '');
          // Remove temp config if it exists
          if (fs.existsSync(originalPath)) {
            fs.unlinkSync(originalPath);
          }
          console.log('Restoring sst.config from backup after error...');
          fs.renameSync(backupPath, originalPath);
          break;
        }
      }

      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
