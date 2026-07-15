import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResolvedCloudflareDeploymentInputs,
  buildCloudflareD1Environment,
  buildCloudflareR2Environment,
  buildCloudflareWranglerConfig,
  fingerprintBuildContext,
  normalizeCloudflareWorkerName,
  resolveCloudflareLinks,
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

  it('does not add Worker bindings for REST-based D1 or R2 access', () => {
    const config = buildCloudflareWranglerConfig(
      deploymentInputs(),
    ) as any;

    expect(config).not.toHaveProperty('d1_databases');
    expect(config).not.toHaveProperty('r2_buckets');
  });
});

describe('resolveCloudflareLinks', () => {
  const d1 = (databaseId: string) => ({
    getSSTLink: () => ({
      properties: { databaseId },
      include: [
        {
          type: 'cloudflare.binding',
          binding: 'd1DatabaseBindings',
          properties: { id: databaseId },
        },
      ],
    }),
  });
  const r2 = (bucketName: string) => ({
    getSSTLink: () => ({
      properties: { name: bucketName },
      include: [
        {
          type: 'cloudflare.binding',
          binding: 'r2BucketBindings',
          properties: { bucketName },
        },
      ],
    }),
  });

  it('extracts D1 and R2 properties from SST Cloudflare links', () => {
    expect(
      resolveCloudflareLinks([
        d1('database-id'),
        r2('bucket-name'),
      ]),
    ).toEqual({
      d1: { databaseId: 'database-id' },
      r2: { bucketName: 'bucket-name' },
    });
  });

  it('supports the resource and environment callback link form', () => {
    expect(
      resolveCloudflareLinks([
        { resource: d1('database-id'), environment: () => ({}) },
      ]),
    ).toEqual({
      d1: { databaseId: 'database-id' },
      r2: undefined,
    });
  });

  it('allows either supported resource to be linked independently', () => {
    expect(resolveCloudflareLinks([r2('bucket-name')])).toEqual({
      d1: undefined,
      r2: { bucketName: 'bucket-name' },
    });
    expect(resolveCloudflareLinks(undefined)).toEqual({});
  });

  it('rejects unsupported and duplicate resource types', () => {
    expect(() =>
      resolveCloudflareLinks([{ getSSTLink: () => ({ include: [] }) }]),
    ).toThrow(/supports link only/);
    expect(() =>
      resolveCloudflareLinks([d1('first'), d1('second')]),
    ).toThrow(/at most one.*D1/);
    expect(() =>
      resolveCloudflareLinks([r2('first'), r2('second')]),
    ).toThrow(/at most one.*Bucket/);
  });
});

describe('buildCloudflareD1Environment', () => {
  it('configures the REST D1 driver and database cache store', () => {
    expect(
      buildCloudflareD1Environment('database-id', 'account-id'),
    ).toEqual({
      DB_CONNECTION: 'd1',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_D1_DATABASE_ID: 'database-id',
      CACHE_STORE: 'database',
      CACHE_DRIVER: 'database',
      DB_CACHE_CONNECTION: 'd1',
      DB_CACHE_LOCK_CONNECTION: 'd1',
    });
  });

  it('allows the account ID to come from the runtime environment', () => {
    expect(buildCloudflareD1Environment('database-id')).not.toHaveProperty(
      'CLOUDFLARE_ACCOUNT_ID',
    );
  });
});

describe('buildCloudflareR2Environment', () => {
  it('configures Laravel S3 storage against the linked R2 bucket', () => {
    expect(
      buildCloudflareR2Environment('bucket-name', 'account-id'),
    ).toEqual({
      FILESYSTEM_DISK: 's3',
      AWS_BUCKET: 'bucket-name',
      AWS_DEFAULT_REGION: 'auto',
      AWS_ENDPOINT:
        'https://account-id.r2.cloudflarestorage.com',
      AWS_USE_PATH_STYLE_ENDPOINT: 'false',
    });
  });

  it('requires an account ID to construct the R2 endpoint', () => {
    expect(() =>
      buildCloudflareR2Environment('bucket-name', ''),
    ).toThrow(/cloudflare.accountId is required/);
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

  it('changes when a package build dependency changes', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sst-laravel-cloudflare-'),
    );
    const dependencyDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sst-laravel-package-'),
    );
    directories.push(directory, dependencyDirectory);
    const dependency = path.join(
      dependencyDirectory,
      'Dockerfile.cloudflare',
    );
    fs.writeFileSync(path.join(directory, 'artisan'), 'application');
    fs.writeFileSync(dependency, 'first');

    const first = fingerprintBuildContext(directory, [dependency]);
    fs.writeFileSync(dependency, 'second');

    expect(fingerprintBuildContext(directory, [dependency])).not.toBe(
      first,
    );
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
