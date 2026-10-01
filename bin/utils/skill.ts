import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getPackageRoot } from './sst-config.js';
import { runProcess } from './process.js';

export const SKILL_NAME = 'sst-laravel';

/**
 * Where the skill goes without Laravel Boost: the shared `.agents/skills`
 * folder that Codex and the Agent Skills spec read, plus the folder of every
 * agent already set up in the project.
 */
export const SHARED_SKILLS_DIR = path.join('.agents', 'skills');
export const AGENT_FOLDERS = ['.claude', '.cursor', '.gemini', '.windsurf', '.codex'];

// Custom skills in `.ai/skills` arrived in Laravel Boost 2.0.
const MIN_BOOST_VERSION = '2.0.0';

export type SkillTarget =
  | { type: 'boost'; version: string }
  | { type: 'package'; reason?: string };

export const isVersionAtLeast = (version: string, minimum: string) => {
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

/**
 * Returns the installed laravel/boost version, or null when it is not
 * installed. Reads Composer's install metadata first so it works without the
 * `composer` binary, then falls back to `composer show`.
 */
export const detectLaravelBoostVersion = (cwd: string): string | null => {
  const installedPath = path.join(cwd, 'vendor', 'composer', 'installed.json');

  if (fs.existsSync(installedPath)) {
    try {
      const installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
      // Composer 2 wraps the list in `packages`; Composer 1 is a bare array.
      const packages: Array<{ name?: string; version?: string }> = Array.isArray(installed)
        ? installed
        : installed.packages ?? [];
      const boost = packages.find((pkg) => pkg.name === 'laravel/boost');

      return boost?.version ? boost.version.replace(/^v/, '') : null;
    } catch {
      // Unreadable metadata: fall back to Composer below.
    }
  }

  try {
    const output = execSync('composer show laravel/boost --no-ansi --no-interaction', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString();

    const versionMatch = output.match(/versions?\s*:\s*\*?\s*v?([0-9][^\s]*)/i);
    return versionMatch ? versionMatch[1].replace(/^v/, '') : null;
  } catch {
    return null;
  }
};

/**
 * The agents Laravel Boost is set up for, from the `boost.json` that
 * `boost:install` writes. Empty when Boost is not set up.
 */
const readBoostAgents = (cwd: string): string[] => {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(cwd, 'boost.json'), 'utf-8'));
    return Array.isArray(config.agents) ? config.agents : [];
  } catch {
    return [];
  }
};

/**
 * Laravel Boost manages the skill when it is installed (2.0+) and set up.
 * `boost:update` refuses to run unless `boost.json` lists at least one agent.
 * Everything else gets a copy of the skill from the installed package.
 */
export const resolveSkillTarget = (cwd: string): SkillTarget => {
  const boostVersion = detectLaravelBoostVersion(cwd);

  if (!boostVersion) {
    return { type: 'package' };
  }

  if (!isVersionAtLeast(boostVersion, MIN_BOOST_VERSION)) {
    return {
      type: 'package',
      reason: `Laravel Boost ${boostVersion} does not support custom skills (needs ${MIN_BOOST_VERSION}+).`,
    };
  }

  if (readBoostAgents(cwd).length === 0) {
    return {
      type: 'package',
      reason: 'Laravel Boost is installed but not set up for any agents (no agents in boost.json). Run `php artisan boost:install` to manage skills with Boost.',
    };
  }

  return { type: 'boost', version: boostVersion };
};

const skillSource = () => path.join(getPackageRoot(), 'resources', 'boost', 'skills', SKILL_NAME);

const copySkill = (target: string) => {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(skillSource(), target, { recursive: true });
};

/**
 * Copies the skill from this package into `.ai/skills/` and runs
 * `boost:update`, which installs it for every agent Boost is set up for.
 */
export const installSkillWithBoost = async (cwd: string) => {
  const target = path.join(cwd, '.ai', 'skills', SKILL_NAME);
  copySkill(target);

  console.log(`Copied the skill to ${path.relative(cwd, target)}`);
  console.log('Running boost:update so Boost installs it for your agents...');
  await runProcess('php', ['artisan', 'boost:update', '--no-interaction'], cwd);
};

/**
 * Copies the skill from the installed package into `.agents/skills/` and
 * into the skills folder of every agent set up in the project. The copy
 * matches the installed package version, so the commands and options it
 * describes are the ones the CLI has.
 */
export const installSkillFromPackage = (cwd: string): string[] => {
  const targets = [
    path.join(cwd, SHARED_SKILLS_DIR, SKILL_NAME),
    ...AGENT_FOLDERS.filter((folder) => fs.existsSync(path.join(cwd, folder))).map((folder) =>
      path.join(cwd, folder, 'skills', SKILL_NAME),
    ),
  ];

  for (const target of targets) {
    copySkill(target);
  }

  return targets.map((target) => path.relative(cwd, target));
};

export const installSkill = async (cwd: string) => {
  const target = resolveSkillTarget(cwd);

  if (target.type === 'boost') {
    console.log(`Laravel Boost ${target.version} detected. Installing the skill in .ai/skills.`);
    await installSkillWithBoost(cwd);
    return;
  }

  if (target.reason) {
    console.log(target.reason);
  }

  const installed = installSkillFromPackage(cwd);
  console.log(`Copied the skill from the installed package to ${installed.join(', ')}`);
};
