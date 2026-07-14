import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResolvedCloudflareDeploymentInputs,
  buildCloudflareWranglerConfig,
  fingerprintBuildContext,
  normalizeCloudflareWorkerName,
  resolveCloudflareInstanceType,
} from '../src/cloudflare';

describe('resolveCloudflareInstanceType', () => {
  it('uses a PHP-friendly basic instance by default', () => {
    expect(resolveCloudflareInstanceType({})).toBe('basic');
  });

  it('honors an explicit instance type', () => {
    expect(
      resolveCloudflareInstanceType({ instanceType: 'standard-3' }),
    ).toBe('standard-3');
  });

  it('selects the smallest predefined instance that satisfies the request', () => {
    expect(resolveCloudflareInstanceType({ memory: '2 GB' })).toBe(
      'standard-1',
    );
    expect(
      resolveCloudflareInstanceType({
        cpu: '1 vCPU',
        memory: '6 GB',
        storage: '12 GB',
      }),
    ).toBe('standard-2');
  });

  it('accepts the numeric ECS units used by older package examples', () => {
    expect(
      resolveCloudflareInstanceType({ cpu: 1024, memory: 2048 }),
    ).toBe('standard-2');
  });

  it('rejects requests beyond Cloudflare limits', () => {
    expect(() =>
      resolveCloudflareInstanceType({ storage: '30 GB' }),
    ).toThrow(/exceeds Cloudflare Containers limits/);
  });
});

describe('buildCloudflareWranglerConfig', () => {
  it('builds a web Container, Durable Object binding, and custom domain', () => {
    const config = buildCloudflareWranglerConfig(
      deploymentInputs({
        domain: 'app.example.com',
        environment: {
          APP_NAME: 'Laravel',
          DB_PASSWORD: 'plain-config-value',
        },
      }),
      ['DB_PASSWORD'],
    ) as any;

    expect(config.containers).toEqual([
      expect.objectContaining({
        class_name: 'LaravelWebContainer',
        instance_type: 'basic',
        max_instances: 3,
      }),
    ]);
    expect(config.durable_objects.bindings).toEqual([
      { name: 'LARAVEL_WEB', class_name: 'LaravelWebContainer' },
    ]);
    expect(config.routes).toEqual([
      { pattern: 'app.example.com', custom_domain: true },
    ]);
    expect(config.vars.APP_NAME).toBe('Laravel');
    expect(config.vars).not.toHaveProperty('DB_PASSWORD');
    expect(JSON.parse(config.vars.SST_LARAVEL_CONTAINER_ENV_KEYS)).toEqual([
      'APP_NAME',
      'DB_PASSWORD',
    ]);
  });

  it('rejects a non-positive instance count', () => {
    expect(() =>
      buildCloudflareWranglerConfig(deploymentInputs({ maxInstances: 0 })),
    ).toThrow(/positive integer/);
  });
});

describe('normalizeCloudflareWorkerName', () => {
  it('produces a Cloudflare-safe, bounded name', () => {
    expect(normalizeCloudflareWorkerName('My Laravel_App!')).toBe(
      'my-laravel-app',
    );
    expect(normalizeCloudflareWorkerName('x'.repeat(100))).toHaveLength(63);
  });
});

describe('fingerprintBuildContext', () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    );
  });

  it('changes when application files change and ignores generated SST files', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sst-laravel-cloudflare-'),
    );
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'artisan'), 'first');

    const first = fingerprintBuildContext(directory);
    fs.writeFileSync(path.join(directory, 'artisan'), 'second');
    const second = fingerprintBuildContext(directory);
    fs.mkdirSync(path.join(directory, '.sst'));
    fs.writeFileSync(path.join(directory, '.sst/generated'), 'ignored');

    expect(second).not.toBe(first);
    expect(fingerprintBuildContext(directory)).toBe(second);
  });
});

function deploymentInputs(
  overrides: Partial<ResolvedCloudflareDeploymentInputs> = {},
): ResolvedCloudflareDeploymentInputs {
  return {
    workerName: 'my-app-production-laravel',
    buildPath: '/tmp/build',
    sitePath: '/tmp/app',
    workerEntrypoint: '/tmp/package/cloudflare/worker.ts',
    dockerfile: '/tmp/package/Dockerfile.cloudflare',
    wranglerCli: '/tmp/package/node_modules/wrangler/bin/wrangler.js',
    compatibilityDate: '2026-07-14',
    phpVersion: '8.4',
    opcache: true,
    instanceType: 'basic',
    maxInstances: 3,
    sleepAfter: '10m',
    httpsRedirect: true,
    healthPath: '/up',
    contextFingerprint: 'fingerprint',
    ...overrides,
  };
}
