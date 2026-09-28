import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { getPackageRoot } from '../utils/sst-config.js';

interface GuideOptions {
  reference?: boolean;
}

export const guideCommand = new Command('guide')
  .description('Print the step-by-step deploy guide for AI agents (use --reference for the short config reference)')
  .option('--reference', 'Print the short config reference (docs/llms.txt) instead')
  .action((options: GuideOptions) => {
    const packageRoot = getPackageRoot();
    const guidePath = options.reference
      ? path.join(packageRoot, 'docs', 'llms.txt')
      : path.join(packageRoot, 'resources', 'boost', 'skills', 'sst-laravel', 'SKILL.md');

    if (!fs.existsSync(guidePath)) {
      console.error(`Error: Guide file not found at ${guidePath}.`);
      process.exit(1);
    }

    // Drop the skill frontmatter; agents only need the instructions.
    const content = fs
      .readFileSync(guidePath, 'utf-8')
      .replace(/^---\n[\s\S]*?\n---\n+/, '');

    process.stdout.write(content);
  });
