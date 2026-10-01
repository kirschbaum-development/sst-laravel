import { Command } from 'commander';
import { installSkill } from '../utils/skill.js';

export const skillInstallCommand = new Command('skill:install')
  .description('Install or update the SST Laravel agent skill (in .ai/skills when Laravel Boost is set up, otherwise in .agents/skills and each agent folder)')
  .action(async () => {
    try {
      await installSkill(process.cwd());
      console.log('SST Laravel skill installed.');
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
