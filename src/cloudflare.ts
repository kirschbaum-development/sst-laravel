import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dynamic } from '@pulumi/pulumi';
import type {
  CustomResourceOptions,
  Input,
  Output,
} from '@pulumi/pulumi';

export const CLOUDFLARE_INSTANCE_TYPES = [
  'lite',
  'basic',
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
] as const;

export type CloudflareInstanceType =
  (typeof CLOUDFLARE_INSTANCE_TYPES)[number];

export type CloudflareRegion =
  | 'ENAM'
  | 'WNAM'
  | 'EEUR'
  | 'WEUR'
  | 'APAC'
  | 'SAM'
  | 'ME'
  | 'OC'
  | 'AFR';

export interface CloudflareD1Link {
  databaseId: Input<string>;
}

export interface LaravelCloudflareArgs {
  /** Cloudflare account to deploy into and expose to a linked D1 REST driver. Wrangler's configured account is used for deployment when omitted. */
  accountId?: Input<string>;

  /** Override the instance type inferred from web.cpu, web.memory, and web.storage. */
  instanceType?: Input<CloudflareInstanceType>;

  /** Stop an idle web container after this duration. @default "10m" */
  sleepAfter?: Input<string>;

  /** Override the generated Worker name. */
  workerName?: Input<string>;

  /** Worker compatibility date. @default "2026-07-14" */
  compatibilityDate?: Input<string>;

  /** Restrict where the container may be placed. */
  regions?: Input<Input<CloudflareRegion>[]>;

  /** Restrict the container to a Cloudflare compliance boundary. */
  jurisdiction?: Input<'eu' | 'fedramp'>;
}

export interface CloudflareDeploymentInputs {
  workerName: Input<string>;
  accountId?: Input<string>;
  buildPath: Input<string>;
  sitePath: Input<string>;
  workerEntrypoint: Input<string>;
  dockerfile: Input<string>;
  wranglerCli: Input<string>;
  compatibilityDate: Input<string>;
  phpVersion: Input<string>;
  opcache: Input<boolean>;
  instanceType: Input<CloudflareInstanceType>;
  maxInstances: Input<number>;
  sleepAfter: Input<string>;
  domain?: Input<string | undefined>;
  httpsRedirect: Input<boolean>;
  healthPath: Input<string>;
  environment?: Input<Record<string, Input<string>>>;
  environmentFile?: Input<string | undefined>;
  regions?: Input<Input<CloudflareRegion>[]>;
  jurisdiction?: Input<'eu' | 'fedramp'>;
  contextFingerprint: Input<string>;
  url?: Input<string | undefined>;
}

export interface ResolvedCloudflareDeploymentInputs {
  workerName: string;
  accountId?: string;
  buildPath: string;
  sitePath: string;
  workerEntrypoint: string;
  dockerfile: string;
  wranglerCli: string;
  compatibilityDate: string;
  phpVersion: string;
  opcache: boolean;
  instanceType: CloudflareInstanceType;
  maxInstances: number;
  sleepAfter: string;
  domain?: string;
  httpsRedirect: boolean;
  healthPath: string;
  environment?: Record<string, string>;
  environmentFile?: string;
  regions?: CloudflareRegion[];
  jurisdiction?: 'eu' | 'fedramp';
  contextFingerprint: string;
  url?: string;
}

const cloudflareDeploymentProvider: dynamic.ResourceProvider<
  ResolvedCloudflareDeploymentInputs,
  ResolvedCloudflareDeploymentInputs
> = {
  async create(inputs) {
    const outs = await deployCloudflareApplication(inputs);

    return {
      id: inputs.workerName,
      outs,
    };
  },

  async diff(_, olds, news) {
    const replaces = ['workerName', 'accountId'].filter(
      (key) =>
        olds[key as keyof ResolvedCloudflareDeploymentInputs] !==
        news[key as keyof ResolvedCloudflareDeploymentInputs],
    );

    return {
      changes:
        stableStringify(comparableDeploymentInputs(olds)) !==
        stableStringify(comparableDeploymentInputs(news)),
      replaces,
      deleteBeforeReplace: replaces.length > 0,
    };
  },

  async update(_, __, news) {
    return {
      outs: await deployCloudflareApplication(news),
    };
  },

  async delete(_, inputs) {
    await writeCloudflareDeploymentFiles(inputs);

    try {
      await runWrangler(inputs, ['delete', '--force']);
    } catch (error) {
      if (!String(error).toLowerCase().includes('not found')) {
        throw error;
      }
    }
  },
};

export class CloudflareLaravelDeployment extends dynamic.Resource {
  public readonly url!: Output<string | undefined>;

  constructor(
    name: string,
    args: CloudflareDeploymentInputs,
    opts?: CustomResourceOptions,
  ) {
    super(
      cloudflareDeploymentProvider,
      `${name}.sst.cloudflare.LaravelDeployment`,
      { ...args, url: args.url },
      opts,
    );
  }
}

export function buildCloudflareWranglerConfig(
  inputs: ResolvedCloudflareDeploymentInputs,
  environmentFileKeys: string[] = [],
) {
  assertPositiveInteger(inputs.maxInstances, 'web.scaling.max');

  const secretKeys = new Set(environmentFileKeys);
  const environment = Object.fromEntries(
    Object.entries(inputs.environment ?? {}).filter(
      ([key]) => !secretKeys.has(key),
    ),
  );
  const containerEnvironmentKeys = [
    ...new Set([...Object.keys(environment), ...environmentFileKeys]),
  ].sort();
  const constraints = {
    ...(inputs.regions?.length ? { regions: inputs.regions } : {}),
    ...(inputs.jurisdiction
      ? { jurisdiction: inputs.jurisdiction }
      : {}),
  };

  return removeUndefined({
    name: inputs.workerName,
    account_id: inputs.accountId,
    main: inputs.workerEntrypoint,
    compatibility_date: inputs.compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    observability: { enabled: true },
    vars: {
      ...environment,
      SST_LARAVEL_CONTAINER_ENV_KEYS: JSON.stringify(
        containerEnvironmentKeys,
      ),
      SST_LARAVEL_HEALTH_PATH: inputs.healthPath,
      SST_LARAVEL_HTTPS_REDIRECT: inputs.httpsRedirect ? 'true' : 'false',
      SST_LARAVEL_INSTANCE_COUNT: inputs.maxInstances.toString(),
      SST_LARAVEL_SLEEP_AFTER: inputs.sleepAfter,
    },
    containers: [
      {
        name: `${inputs.workerName}-web`,
        class_name: 'LaravelWebContainer',
        image: inputs.dockerfile,
        image_build_context: inputs.sitePath,
        image_vars: {
          PHP_VERSION: inputs.phpVersion,
          PHP_OPCACHE_ENABLE: inputs.opcache ? '1' : '0',
        },
        instance_type: inputs.instanceType,
        max_instances: inputs.maxInstances,
        ...(Object.keys(constraints).length ? { constraints } : {}),
      },
    ],
    durable_objects: {
      bindings: [
        {
          name: 'LARAVEL_WEB',
          class_name: 'LaravelWebContainer',
        },
      ],
    },
    migrations: [
      {
        tag: 'v1',
        new_sqlite_classes: ['LaravelWebContainer'],
      },
    ],
    routes: inputs.domain
      ? [{ pattern: inputs.domain, custom_domain: true }]
      : undefined,
  });
}

/**
 * Resolve the single SST Cloudflare D1 resource supported by the Laravel
 * Container prototype. SST exposes provider-native bindings through the
 * resource's getSSTLink() definition.
 */
export function resolveCloudflareD1Link(
  links: unknown[] | undefined,
): CloudflareD1Link | undefined {
  if (!links?.length) {
    return undefined;
  }

  const databaseIds = links.flatMap((link) => {
    const resource = unwrapLinkResource(link);

    if (!resource || typeof resource.getSSTLink !== 'function') {
      throw unsupportedCloudflareLinkError();
    }

    const definition = resource.getSSTLink();
    const bindings = Array.isArray(definition?.include)
      ? definition.include.filter(
          (item: unknown): item is CloudflareD1BindingDescriptor =>
            isCloudflareD1Binding(item),
        )
      : [];

    if (bindings.length !== 1) {
      throw unsupportedCloudflareLinkError();
    }

    return bindings.map((binding) => binding.properties.id);
  });

  if (databaseIds.length !== 1) {
    throw new Error(
      'provider: "cloudflare" currently supports linking exactly one sst.cloudflare.D1 database.',
    );
  }

  return { databaseId: databaseIds[0] };
}

export function buildCloudflareD1Environment(
  databaseId: string,
  accountId?: string,
) {
  return {
    DB_CONNECTION: 'd1',
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    CLOUDFLARE_D1_DATABASE_ID: databaseId,
    CACHE_STORE: 'database',
    CACHE_DRIVER: 'database',
    DB_CACHE_CONNECTION: 'd1',
    DB_CACHE_LOCK_CONNECTION: 'd1',
  };
}

type CloudflareD1BindingDescriptor = {
  type: 'cloudflare.binding';
  binding: 'd1DatabaseBindings';
  properties: { id: Input<string> };
};

function isCloudflareD1Binding(
  value: unknown,
): value is CloudflareD1BindingDescriptor {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const binding = value as Partial<CloudflareD1BindingDescriptor>;

  return (
    binding.type === 'cloudflare.binding' &&
    binding.binding === 'd1DatabaseBindings' &&
    !!binding.properties &&
    'id' in binding.properties
  );
}

function unwrapLinkResource(value: unknown): {
  getSSTLink?: () => { include?: unknown[] };
} | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if ('resource' in value) {
    const resource = (value as { resource?: unknown }).resource;

    return resource && typeof resource === 'object'
      ? (resource as { getSSTLink?: () => { include?: unknown[] } })
      : undefined;
  }

  return value as { getSSTLink?: () => { include?: unknown[] } };
}

function unsupportedCloudflareLinkError() {
  return new Error(
    'provider: "cloudflare" currently supports link only for an sst.cloudflare.D1 database.',
  );
}

export function resolveCloudflareInstanceType(options: {
  instanceType?: unknown;
  cpu?: unknown;
  memory?: unknown;
  storage?: unknown;
}): CloudflareInstanceType {
  if (options.instanceType !== undefined) {
    if (
      !CLOUDFLARE_INSTANCE_TYPES.includes(
        options.instanceType as CloudflareInstanceType,
      )
    ) {
      throw new Error(
        `Invalid cloudflare.instanceType "${options.instanceType}".`,
      );
    }

    return options.instanceType as CloudflareInstanceType;
  }

  const requested = {
    cpu: parseCpu(options.cpu),
    memory: parseMemory(options.memory),
    storage: parseStorage(options.storage),
  };

  if (Object.values(requested).every((value) => value === 0)) {
    return 'basic';
  }

  const types: Array<{
    name: CloudflareInstanceType;
    cpu: number;
    memory: number;
    storage: number;
  }> = [
    { name: 'lite', cpu: 1 / 16, memory: 0.25, storage: 2 },
    { name: 'basic', cpu: 0.25, memory: 1, storage: 4 },
    { name: 'standard-1', cpu: 0.5, memory: 4, storage: 8 },
    { name: 'standard-2', cpu: 1, memory: 6, storage: 12 },
    { name: 'standard-3', cpu: 2, memory: 8, storage: 16 },
    { name: 'standard-4', cpu: 4, memory: 12, storage: 20 },
  ];
  const match = types.find(
    (type) =>
      type.cpu >= requested.cpu &&
      type.memory >= requested.memory &&
      type.storage >= requested.storage,
  );

  if (!match) {
    throw new Error(
      'The requested web.cpu, web.memory, or web.storage exceeds Cloudflare Containers limits. Use at most 4 vCPU, 12 GB memory, and 20 GB storage.',
    );
  }

  return match.name;
}

export function normalizeCloudflareWorkerName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

  return normalized || 'sst-laravel';
}

export function fingerprintBuildContext(root: string): string {
  const hash = crypto.createHash('sha256');
  const ignoredDirectories = new Set(['.git', '.sst', 'node_modules']);

  visit(root);

  return hash.digest('hex');

  function visit(directory: string) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);

      hash.update(relative);

      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        hash.update(fs.readFileSync(absolute));
      } else if (entry.isSymbolicLink()) {
        hash.update(fs.readlinkSync(absolute));
      }
    }
  }
}

export function resolveWranglerCli(packageRoot: string): string {
  const packageJsonCandidates = [
    path.join(packageRoot, 'node_modules/wrangler/package.json'),
    path.join(path.dirname(packageRoot), 'wrangler/package.json'),
    path.join(process.cwd(), 'node_modules/wrangler/package.json'),
  ];

  for (const packageJsonPath of packageJsonCandidates) {
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.wrangler;

    if (bin) {
      return path.resolve(path.dirname(packageJsonPath), bin);
    }
  }

  throw new Error(
    'Unable to locate Wrangler. Install the package dependencies before deploying with provider: "cloudflare".',
  );
}

async function writeCloudflareDeploymentFiles(
  inputs: ResolvedCloudflareDeploymentInputs,
) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const environmentFileKeys = inputs.environmentFile
    ? readEnvironmentFileKeys(fs, inputs.environmentFile)
    : [];
  const config = buildCloudflareWranglerConfig(
    inputs,
    environmentFileKeys,
  );
  const configPath = path.join(inputs.buildPath, 'wrangler.json');

  fs.mkdirSync(inputs.buildPath, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  return configPath;
}

async function deployCloudflareApplication(
  inputs: ResolvedCloudflareDeploymentInputs,
) {
  await writeCloudflareDeploymentFiles(inputs);
  const { stdout, stderr } = await runWrangler(inputs, ['deploy']);
  const url =
    (inputs.domain ? `https://${inputs.domain}` : undefined) ??
    findWorkersDevUrl(`${stdout}\n${stderr}`);

  return {
    ...inputs,
    url,
  };
}

async function runWrangler(
  inputs: ResolvedCloudflareDeploymentInputs,
  command: string[],
) {
  const childProcess = await import('node:child_process');
  const path = await import('node:path');
  const util = await import('node:util');
  const execFile = util.promisify(childProcess.execFile);
  const configPath = path.join(inputs.buildPath, 'wrangler.json');
  const args = [inputs.wranglerCli, ...command, '--config', configPath];

  if (command[0] === 'deploy' && inputs.environmentFile) {
    args.push('--secrets-file', inputs.environmentFile);
  }

  try {
    return await execFile(process.execPath, args, {
      cwd: inputs.sitePath,
      env: {
        ...process.env,
        NO_COLOR: '1',
        WRANGLER_SEND_METRICS: 'false',
      },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string };

    throw new Error(
      [
        `Wrangler ${command[0]} failed for ${inputs.workerName}.`,
        details.stdout,
        details.stderr,
        details.message,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function readEnvironmentFileKeys(
  fs: typeof import('node:fs'),
  filePath: string,
): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Environment file not found at ${filePath}.`);
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return match ? [match[1]] : [];
    });
}

function findWorkersDevUrl(output: string): string | undefined {
  return output
    .match(/https:\/\/[^\s"'`]+/g)
    ?.map((url) => url.replace(/[),.;]+$/g, ''))
    .find((url) => url.includes('.workers.dev'));
}

function parseCpu(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = parseNumber(value, 'web.cpu');
  return typeof value === 'number' && parsed > 16 ? parsed / 1024 : parsed;
}

function parseMemory(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = parseNumber(value, 'web.memory');

  if (typeof value === 'number') {
    return parsed > 64 ? parsed / 1024 : parsed;
  }

  return /mib|mb/i.test(String(value)) ? parsed / 1024 : parsed;
}

function parseStorage(value: unknown): number {
  if (value === undefined) return 0;
  return parseNumber(value, 'web.storage');
}

function parseNumber(value: unknown, option: string): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(String(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${option} value "${value}".`);
  }

  return parsed;
}

function assertPositiveInteger(value: number, option: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
}

function comparableDeploymentInputs(
  inputs: ResolvedCloudflareDeploymentInputs,
) {
  const { url: _url, ...comparable } = inputs;
  return comparable;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }

  return value;
}

function removeUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}
