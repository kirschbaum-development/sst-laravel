import { Command } from 'commander';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface CheckResult {
  label: string;
  ok: boolean;
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

function envValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!match) {
    return null;
  }

  return match[1].trim().replace(/^["']|["']$/g, '');
}

export const doctorCommand = new Command('doctor')
  .description('Check that this machine and Laravel app are ready to deploy with SST Laravel')
  .action(() => {
    const cwd = process.cwd();
    const results: CheckResult[] = [];

    // Tools
    const phpVersion = runCommand('php --version');
    results.push({
      label: 'PHP',
      ok: phpVersion !== null,
      detail: phpVersion ? phpVersion.split('\n')[0] : 'not found — install PHP to run artisan commands',
    });

    const nodeVersion = runCommand('node --version');
    results.push({
      label: 'Node.js',
      ok: nodeVersion !== null,
      detail: nodeVersion ?? 'not found — SST needs Node.js',
    });

    const awsVersion = runCommand('aws --version');
    results.push({
      label: 'AWS CLI',
      ok: awsVersion !== null,
      detail: awsVersion ?? 'not found — install it to deploy (https://docs.aws.amazon.com/cli/)',
    });

    // AWS identity (never prints secrets, only the account/ARN names)
    const identity = runCommand('aws sts get-caller-identity');
    if (identity) {
      try {
        const parsed = JSON.parse(identity) as { Account?: string; Arn?: string };
        results.push({
          label: 'AWS login',
          ok: true,
          detail: `account ${parsed.Account ?? '?'} (${parsed.Arn ?? 'unknown identity'})`,
        });
      } catch {
        results.push({ label: 'AWS login', ok: true, detail: 'connected' });
      }
    } else {
      results.push({
        label: 'AWS login',
        ok: false,
        detail: 'not logged in — run `aws sso login` or set a profile before deploying',
      });
    }

    const region =
      process.env.AWS_REGION ||
      runCommand('aws configure get region') ||
      'unknown (set AWS_REGION)';
    results.push({ label: 'AWS region', ok: region !== 'unknown (set AWS_REGION)', detail: region });

    // Laravel app
    const composer = readFileIfExists(path.join(cwd, 'composer.json'));
    const isLaravel = composer !== null && composer.includes('laravel/framework');
    results.push({
      label: 'Laravel app',
      ok: isLaravel,
      detail: isLaravel ? 'laravel/framework found in composer.json' : 'no laravel/framework in composer.json — run this in your Laravel folder',
    });

    const envExample = readFileIfExists(path.join(cwd, '.env.example'));
    if (envExample) {
      const drivers = [
        `database: ${envValue(envExample, 'DB_CONNECTION') ?? 'not set'}`,
        `cache: ${envValue(envExample, 'CACHE_STORE') ?? 'not set'}`,
        `session: ${envValue(envExample, 'SESSION_DRIVER') ?? 'not set'}`,
        `queue: ${envValue(envExample, 'QUEUE_CONNECTION') ?? 'not set'}`,
      ].join(', ');
      const needsDb = (envValue(envExample, 'DB_CONNECTION') ?? '') !== 'sqlite';
      results.push({
        label: '.env.example drivers',
        ok: true,
        detail: `${drivers}${needsDb ? ' — a persistent database is needed before enabling migrations' : ''}`,
      });
    } else {
      results.push({ label: '.env.example drivers', ok: false, detail: '.env.example not found' });
    }

    // Trusted proxies (needed behind the load balancer)
    const bootstrapApp = readFileIfExists(path.join(cwd, 'bootstrap', 'app.php'));
    if (bootstrapApp) {
      const trustsProxies = bootstrapApp.includes('trustProxies');
      results.push({
        label: 'Trusted proxies',
        ok: trustsProxies,
        detail: trustsProxies
          ? 'trustProxies is configured (needed behind the load balancer)'
          : 'missing — add `$middleware->trustProxies(at: "*")` in bootstrap/app.php or assets may load over http',
      });
    }

    // SST config
    const hasSstConfig =
      fs.existsSync(path.join(cwd, 'sst.config.ts')) || fs.existsSync(path.join(cwd, 'sst.config.js'));
    results.push({
      label: 'sst.config.ts',
      ok: hasSstConfig,
      detail: hasSstConfig ? 'found' : 'missing — run `npx sst-laravel init` to create one',
    });

    // Stage env files ignored by git?
    const gitignore = readFileIfExists(path.join(cwd, '.gitignore'));
    if (gitignore) {
      const ignoresEnvFiles = gitignore.includes('.env.') || gitignore.includes('.env*');
      results.push({
        label: 'Secrets ignored by git',
        ok: ignoresEnvFiles,
        detail: ignoresEnvFiles
          ? 'stage env files look ignored'
          : 'add `.env.dev` / `.env.production` (your stage files) to .gitignore — never commit secrets',
      });
    }

    // Report
    console.log('\nSST Laravel readiness check\n');

    let failed = 0;
    for (const result of results) {
      const mark = result.ok ? 'ok  ' : 'FIX ';
      if (!result.ok) {
        failed += 1;
      }
      console.log(`[${mark}] ${result.label}: ${result.detail}`);
    }

    console.log('');
    if (failed > 0) {
      console.log(`${failed} item(s) need attention above. Fix them, then run this check again.`);
      process.exit(1);
    }

    console.log('Everything looks ready. Next step: `npx sst-laravel deploy --stage dev`.');
  });
