import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Names that come from the Laravel skeleton rather than the project. SST
 * keys its state by app name and stage, so two projects with the same name
 * deploying the same stage into one AWS account overwrite each other.
 */
export const GENERIC_APP_NAMES = ['laravel', 'app', 'example-app', 'my-laravel-app', 'laravel-app', 'example'];

export const SUPPORTED_PHP_VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'];
export const DEFAULT_PHP_VERSION = '8.4';

export const slugify = (name: string): string =>
  name
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const isGenericAppName = (name: string): boolean => GENERIC_APP_NAMES.includes(slugify(name));

export interface AppNameResolution {
  name: string;
  source: 'composer.json' | 'folder' | '.env' | 'default';
  generic: boolean;
}

const readComposerName = (cwd: string): string | null => {
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(cwd, 'composer.json'), 'utf-8'));
    const name = typeof composer.name === 'string' ? composer.name : '';
    // "vendor/project" -> "project"
    return name.includes('/') ? name.split('/').pop() ?? null : name || null;
  } catch {
    return null;
  }
};

const readEnvAppName = (cwd: string): string | null => {
  try {
    const match = fs.readFileSync(path.join(cwd, '.env'), 'utf-8').match(/^APP_NAME=(.+)$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

/**
 * Picks the SST app name: the composer project name, then the folder name,
 * then `APP_NAME`. Skeleton values (`laravel/laravel`, `APP_NAME=Laravel`)
 * are skipped, so a fresh app gets its folder name instead of `laravel`.
 */
export const resolveAppName = (cwd: string): AppNameResolution => {
  const candidates: Array<[AppNameResolution['source'], string | null]> = [
    ['composer.json', readComposerName(cwd)],
    ['folder', path.basename(path.resolve(cwd))],
    ['.env', readEnvAppName(cwd)],
  ];

  for (const [source, raw] of candidates) {
    const name = raw ? slugify(raw) : '';
    if (name && !isGenericAppName(name)) {
      return { name, source, generic: false };
    }
  }

  const fallback = candidates.map(([, raw]) => (raw ? slugify(raw) : '')).find(Boolean);
  return fallback
    ? { name: fallback, source: candidates.find(([, raw]) => raw && slugify(raw) === fallback)?.[0] ?? 'default', generic: true }
    : { name: 'my-laravel-app', source: 'default', generic: true };
};

/** `major.minor` of the PHP on this machine, or null when PHP is missing. */
export const localPhpVersion = (): string | null => {
  try {
    return execSync('php -r "echo PHP_MAJOR_VERSION . \'.\' . PHP_MINOR_VERSION;"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

/**
 * The PHP version for the containers. The image uses the local `vendor`
 * folder, whose platform check expects the PHP it was installed with, so
 * the local version wins when the image supports it.
 */
export const resolvePhpVersion = (local: string | null = localPhpVersion()): string =>
  local && SUPPORTED_PHP_VERSIONS.includes(local) ? local : DEFAULT_PHP_VERSION;

/**
 * Appends the entries that are missing from `.gitignore`. Returns the ones
 * it added.
 */
export const ensureGitIgnore = (cwd: string, entries: string[]): string[] => {
  const gitignorePath = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = existing.split('\n').map((line) => line.trim());
  const missing = entries.filter((entry) => !lines.includes(entry) && !lines.includes(`${entry}/`));

  if (missing.length === 0) {
    return [];
  }

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${existing}${separator}\n# sst\n${missing.join('\n')}\n`);

  return missing;
};
