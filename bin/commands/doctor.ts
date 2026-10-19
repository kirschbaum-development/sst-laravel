import { Command } from 'commander';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { activeProfile, configuredRegion } from '../utils/aws.js';
import { isGenericAppName, localPhpVersion } from '../utils/project.js';
import {
  extractEnvironmentFile,
  extractSecretsConfig,
  extractSstProjectName,
  findSstConfig,
} from '../utils/sst-config.js';

type CheckStatus = 'ok' | 'warn' | 'fix';

interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
}

function runCommand(command: string): string | null {
  try {
    return execSync(command, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function readFileIfExists(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Ignore unreadable files and treat them as missing.
  }

  return null;
}

export function envValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!match) {
    return null;
  }

  return match[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Whether git ignores the path. Works for files that do not exist yet, so
 * the stage file can be checked before it is created. Null outside a git
 * repository.
 */
export function isGitIgnored(cwd: string, file: string): boolean | null {
  const result = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd, stdio: 'ignore' });

  if (result.error || result.status === null || result.status >= 2) {
    return null;
  }

  return result.status === 0;
}

/**
 * The environment files that may hold secrets: every `.env*` in the folder
 * except the example, plus the stage file even when it is not created yet.
 */
export function secretEnvFiles(cwd: string, stageFile: string | null): string[] {
  const existing = fs
    .readdirSync(cwd)
    .filter((name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example'));

  return [...new Set([...existing, ...(stageFile ? [stageFile] : [])])].sort();
}

/** Newest modification time under a folder, for the asset staleness check. */
function newestMtime(dir: string, budget = { files: 5000 }): number {
  let newest = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (budget.files-- <= 0) {
      break;
    }

    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(entryPath, budget));
    } else if (entry.isFile()) {
      newest = Math.max(newest, fs.statSync(entryPath).mtimeMs);
    }
  }

  return newest;
}

export const doctorCommand = new Command('doctor')
  .description('Check that this machine and Laravel app are ready to deploy with SST Laravel')
  .option('-s, --stage <stage>', 'Stage whose environment file to check', 'dev')
  .action((options: { stage: string }) => {
    const cwd = process.cwd();
    const results: CheckResult[] = [];
    const stage = options.stage;

    // Tools
    const phpVersion = runCommand('php --version');
    results.push({
      label: 'PHP',
      status: phpVersion !== null ? 'ok' : 'fix',
      detail: phpVersion ? phpVersion.split('\n')[0] : 'not found — install PHP to run artisan commands',
    });

    const nodeVersion = runCommand('node --version');
    results.push({
      label: 'Node.js',
      status: nodeVersion !== null ? 'ok' : 'fix',
      detail: nodeVersion ?? 'not found — SST needs Node.js',
    });

    const awsVersion = runCommand('aws --version');
    results.push({
      label: 'AWS CLI',
      status: awsVersion !== null ? 'ok' : 'fix',
      detail: awsVersion ?? 'not found — install it to deploy (https://docs.aws.amazon.com/cli/)',
    });

    // The deploy builds the container image on this machine, so the Docker
    // daemon must be running, not just installed.
    const dockerVersion = runCommand('docker --version');
    const dockerServer = dockerVersion ? runCommand('docker info --format "{{.ServerVersion}}"') : null;
    results.push({
      label: 'Docker',
      status: dockerServer !== null ? 'ok' : 'fix',
      detail: dockerServer
        ? `running (server ${dockerServer})`
        : dockerVersion
          ? 'installed but the daemon is not reachable — start Docker (and check your user can access it); the deploy builds the image on this machine'
          : 'not found — install Docker; the deploy builds the image on this machine (https://docs.docker.com/get-docker/)',
    });

    // AWS identity (never prints secrets, only the account/ARN names)
    const profile = activeProfile();
    const profileLabel = profile ? `profile ${profile}` : 'default profile';
    const identity = runCommand('aws sts get-caller-identity');
    if (identity) {
      try {
        const parsed = JSON.parse(identity) as { Account?: string; Arn?: string };
        results.push({
          label: 'AWS login',
          status: 'ok',
          detail: `account ${parsed.Account ?? '?'} (${parsed.Arn ?? 'unknown identity'}), ${profileLabel}`,
        });
      } catch {
        results.push({ label: 'AWS login', status: 'ok', detail: `connected, ${profileLabel}` });
      }
    } else {
      results.push({
        label: 'AWS login',
        status: 'fix',
        detail: profile
          ? `not logged in with ${profileLabel} — run \`aws sso login --profile ${profile}\` (or set its keys) and try again`
          : 'not logged in — with named profiles, run `aws sso login --profile <name>` and `export AWS_PROFILE=<name>` so every sst-laravel and sst command uses it; with no profile yet, run `aws configure sso` (see AWS access in docs/getting-started.md)',
      });
    }

    const region = configuredRegion();
    results.push({
      label: 'AWS region',
      status: region ? 'ok' : 'fix',
      detail: region ?? `none configured — set AWS_REGION or add \`region\` to the ${profileLabel} in ~/.aws/config`,
    });

    // Laravel app
    const composer = readFileIfExists(path.join(cwd, 'composer.json'));
    const isLaravel = composer !== null && composer.includes('laravel/framework');
    results.push({
      label: 'Laravel app',
      status: isLaravel ? 'ok' : 'fix',
      detail: isLaravel ? 'laravel/framework found in composer.json' : 'no laravel/framework in composer.json — run this in your Laravel folder',
    });

    // sst.config.ts imports the package, and `npx sst-laravel` only runs this
    // CLI once it is installed in the project.
    const packageInstalled = fs.existsSync(
      path.join(cwd, 'node_modules', '@kirschbaum-development', 'sst-laravel', 'package.json'),
    );
    results.push({
      label: 'SST Laravel package',
      status: packageInstalled ? 'ok' : 'fix',
      detail: packageInstalled
        ? 'installed in this project'
        : 'not installed — run `npm install @kirschbaum-development/sst-laravel --save`',
    });

    // The image copies the local vendor folder and built assets as they are.
    const vendorInstalled = fs.existsSync(path.join(cwd, 'vendor', 'autoload.php'));
    results.push({
      label: 'Composer dependencies',
      status: vendorInstalled ? 'ok' : 'fix',
      detail: vendorInstalled
        ? 'vendor/ is installed (the image copies it as it is)'
        : 'vendor/ is missing — run `composer install`; the image copies the local vendor folder',
    });

    const usesVite = fs.readdirSync(cwd).some((name) => /^vite\.config\.(js|ts|mjs|cjs|mts)$/.test(name));
    if (usesVite) {
      const manifest = path.join(cwd, 'public', 'build', 'manifest.json');
      if (!fs.existsSync(manifest)) {
        results.push({
          label: 'Frontend assets',
          status: 'fix',
          detail: 'public/build is missing — run `npm run build`; the image copies the built assets as they are',
        });
      } else {
        const resourcesDir = path.join(cwd, 'resources');
        const stale = fs.existsSync(resourcesDir) && newestMtime(resourcesDir) > fs.statSync(manifest).mtimeMs;
        results.push({
          label: 'Frontend assets',
          status: stale ? 'warn' : 'ok',
          detail: stale
            ? 'public/build is older than files in resources/ — run `npm run build` before deploying'
            : 'public/build is present',
        });
      }
    }

    // SST config
    const configPath = findSstConfig();
    results.push({
      label: 'sst.config.ts',
      status: configPath ? 'ok' : 'fix',
      detail: configPath ? 'found' : 'missing — run `npx sst-laravel init` to create one',
    });

    let stageFile: string | null = null;
    if (configPath) {
      const appName = extractSstProjectName(configPath);
      if (appName) {
        results.push({
          label: 'App name',
          status: isGenericAppName(appName) ? 'warn' : 'ok',
          detail: isGenericAppName(appName)
            ? `"${appName}" is generic — SST keys its state by app name and stage, so another project with the same name in this AWS account would overwrite it; pick a unique \`name\` in sst.config.ts`
            : appName,
        });
      }

      // The image copies the local vendor folder, whose platform check
      // expects the PHP it was installed with.
      const configuredPhp = fs.readFileSync(configPath, 'utf-8').match(/\bphp\s*:\s*['"]?(\d+\.\d+)/)?.[1];
      const localPhp = localPhpVersion();
      if (configuredPhp && localPhp && configuredPhp !== localPhp) {
        results.push({
          label: 'PHP version',
          status: 'warn',
          detail: `containers run PHP ${configuredPhp} but vendor/ was installed with PHP ${localPhp} — if dependencies require ${localPhp}, set \`config.php: ${localPhp}\` in sst.config.ts`,
        });
      }

      if (!extractSecretsConfig(configPath)) {
        stageFile = extractEnvironmentFile(configPath, stage);
      }
    }

    // Drivers, from the stage file when it exists, otherwise from the example
    const stageFileExists = stageFile !== null && fs.existsSync(path.join(cwd, stageFile));
    const driverSource = stageFileExists ? (stageFile as string) : '.env.example';
    const driverContent = readFileIfExists(path.join(cwd, driverSource));

    if (stageFile && !stageFileExists) {
      results.push({
        label: `Stage env file (${stage})`,
        status: 'fix',
        detail: `${stageFile} not found — sst.config.ts reads it for the ${stage} stage; create it from .env.example and set APP_KEY`,
      });
    }

    if (driverContent) {
      const db = envValue(driverContent, 'DB_CONNECTION') ?? 'not set';
      const drivers = [
        `database: ${db}`,
        `cache: ${envValue(driverContent, 'CACHE_STORE') ?? 'not set'}`,
        `session: ${envValue(driverContent, 'SESSION_DRIVER') ?? 'not set'}`,
        `queue: ${envValue(driverContent, 'QUEUE_CONNECTION') ?? 'not set'}`,
      ].join(', ');

      if (db === 'sqlite') {
        results.push({
          label: `Drivers (${driverSource})`,
          status: 'warn',
          detail: `${drivers} — the SQLite file lives inside the container, so its data is wiped on every deploy and not shared between containers; link a database for anything but a demo`,
        });
      } else {
        results.push({
          label: `Drivers (${driverSource})`,
          status: 'ok',
          detail: `${drivers} — a persistent database is needed before enabling migrations`,
        });
      }

      if (stageFileExists) {
        const debug = envValue(driverContent, 'APP_DEBUG');
        if (debug === 'true') {
          results.push({
            label: `APP_DEBUG (${driverSource})`,
            status: 'warn',
            detail: 'true — set it to false for any public endpoint',
          });
        }

        if (!envValue(driverContent, 'APP_KEY')) {
          results.push({
            label: `APP_KEY (${driverSource})`,
            status: 'fix',
            detail: `empty — run \`php artisan key:generate --env=${stage}\``,
          });
        }
      }
    } else {
      results.push({ label: 'Drivers', status: 'fix', detail: `${driverSource} not found` });
    }

    // Trusted proxies (needed behind the load balancer)
    const bootstrapApp = readFileIfExists(path.join(cwd, 'bootstrap', 'app.php'));
    if (bootstrapApp) {
      const trustsProxies = bootstrapApp.includes('trustProxies');
      results.push({
        label: 'Trusted proxies',
        status: trustsProxies ? 'ok' : 'fix',
        detail: trustsProxies
          ? 'trustProxies is configured (needed behind the load balancer)'
          : 'missing — add `$middleware->trustProxies(at: "*")` in bootstrap/app.php or assets may load over http',
      });
    }

    // Secrets ignored by git: ask git about each real file instead of
    // pattern-matching .gitignore, which passed `.env.production` for `.env.dev`.
    const envFiles = secretEnvFiles(cwd, stageFile);
    const ignoreStatus = envFiles.map((file) => [file, isGitIgnored(cwd, file)] as const);
    if (envFiles.length === 0) {
      results.push({ label: 'Secrets ignored by git', status: 'ok', detail: 'no env files yet' });
    } else if (ignoreStatus.some(([, ignored]) => ignored === null)) {
      results.push({
        label: 'Secrets ignored by git',
        status: 'warn',
        detail: 'not a git repository (or git is missing) — make sure stage env files never get committed',
      });
    } else {
      const exposed = ignoreStatus.filter(([, ignored]) => ignored === false).map(([file]) => file);
      results.push({
        label: 'Secrets ignored by git',
        status: exposed.length === 0 ? 'ok' : 'fix',
        detail:
          exposed.length === 0
            ? `${envFiles.join(', ')} ignored`
            : `${exposed.join(', ')} not ignored — add them to .gitignore (for example \`.env.*\` with \`!.env.example\`); never commit secrets`,
      });
    }

    // Report
    console.log(`\nSST Laravel readiness check (stage: ${stage})\n`);

    let failed = 0;
    let warned = 0;
    for (const result of results) {
      const mark = { ok: 'ok  ', warn: 'warn', fix: 'FIX ' }[result.status];
      if (result.status === 'fix') {
        failed += 1;
      } else if (result.status === 'warn') {
        warned += 1;
      }
      console.log(`[${mark}] ${result.label}: ${result.detail}`);
    }

    console.log('');
    if (failed > 0) {
      console.log(`${failed} item(s) need attention above. Fix them, then run this check again.`);
      process.exit(1);
    }

    if (warned > 0) {
      console.log(`Ready, with ${warned} warning(s) above to consider. Next step: \`npx sst-laravel deploy --stage ${stage}\`.`);
      return;
    }

    console.log(`Everything looks ready. Next step: \`npx sst-laravel deploy --stage ${stage}\`.`);
  });
