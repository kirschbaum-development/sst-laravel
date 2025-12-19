#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { initCommand } from './commands/init.js';
import { deployCommand } from './commands/deploy.js';
import { sshCommand } from './commands/ssh.js';
import { logsCommand } from './commands/logs.js';
import { githubIamCommand } from './commands/github-iam.js';
import { installCommand } from './commands/install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

const program = new Command();

program
  .name('sst-laravel')
  .description('CLI tools for SST Laravel deployments')
  .version(version);

program.addCommand(initCommand);
program.addCommand(deployCommand);
program.addCommand(sshCommand);
program.addCommand(logsCommand);
program.addCommand(githubIamCommand);
program.addCommand(installCommand);

program.parse();
