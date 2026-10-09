/**
 * Mock deploys of LaravelService against a real SST platform, with Pulumi
 * mocks in place of AWS. Run with `npm run test:component`, which copies the
 * package into a folder next to the platform before running this file there.
 *
 * Each scenario's resources are compared to a snapshot in `__snapshots__`,
 * so a refactor that changes what gets deployed shows up as a diff.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';
import { checkImageInputs } from './provider-rpc';

// Same type and name as the real dynamic resource. Vitest rewrites the
// dynamic imports in its provider, which Pulumi can't serialize; SST's
// bundle keeps them native.
vi.mock('./pkg/@kirschbaum-development/sst-laravel/src/env-file-resource', async () => {
  const { CustomResource } = await import('@pulumi/pulumi');

  class EnvFile extends CustomResource {
    constructor(name: string, args: Record<string, unknown>, opts: pulumi.CustomResourceOptions) {
      super('pulumi-nodejs:dynamic:Resource', `${name}.sst.aws.EnvFile`, args, opts);
    }
  }

  return { EnvFile };
});

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send() {
      return { SecretString: JSON.stringify({ APP_KEY: 'base64:test' }) };
    }
  },
  GetSecretValueCommand: class {},
  PutSecretValueCommand: class {},
  CreateSecretCommand: class {},
  DeleteSecretCommand: class {},
  DescribeSecretCommand: class {},
  ListSecretsCommand: class {},
  ResourceNotFoundException: class extends Error {},
}));

const ROOT = __dirname;
const PACKAGE = path.join(ROOT, 'pkg/@kirschbaum-development/sst-laravel');
const SNAPSHOTS = process.env.SST_LARAVEL_SNAPSHOTS!;

/** The marker Pulumi puts on secret values it serializes. */
const SECRET_SIG = '4dabf18193072939515e22adb298388d';

interface Recorded {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
  parent?: string;
  aliases?: string[];
  dependsOn?: string[];
  retainOnDelete?: boolean;
}

const resources = new Map<string, Recorded>();
let full: any;

const vpc = {
  id: 'vpc-1',
  securityGroups: ['sg-1'],
  containerSubnets: ['subnet-private'],
  loadBalancerSubnets: ['subnet-public'],
  cloudmapNamespaceId: 'ns-1',
  cloudmapNamespaceName: 'local',
};

const cert = 'arn:aws:acm:us-east-1:123456789012:certificate/test';

/** Resolves once no resource has been registered for a second. */
async function settle() {
  let count = -1;

  while (count !== resources.size) {
    count = resources.size;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function startSstServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { method } = JSON.parse(body);
      res.end(JSON.stringify(
        method === 'Provider.Aws.Bootstrap'
          ? {
              result: {
                asset: 'asset-bucket',
                assetEcrRegistryId: '123456789012',
                assetEcrUrl: '123456789012.dkr.ecr.us-east-1.amazonaws.com/sst-asset',
                state: 'state-bucket',
                appsyncHttp: '',
                appsyncRealtime: '',
              },
            }
          : { error: `rpc: can't find ${method}` },
      ));
    });
  });
  server.unref();

  return new Promise((resolve) => server.listen(0, () => {
    resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }));
}

beforeAll(async () => {
  process.env.SST_SERVER = await startSstServer();
  process.env.SST_LARAVEL_PACKAGE_ROOT = PACKAGE;

  pulumi.runtime.setMocks({
    newResource(args) {
      const recorded = resources.get(args.name) ?? { type: args.type, name: args.name, inputs: {} };
      recorded.inputs = args.inputs;
      resources.set(args.name, recorded);

      return {
        id: `${args.name}-id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:us-east-1:123456789012:${args.name}`,
          name: args.inputs.name ?? args.name,
          dnsName: `${args.name}.elb.amazonaws.com`,
          ref: `${args.name}-ref`,
          digest: 'sha256:test',
        },
      };
    },
    call(args) {
      const token = args.token;
      if (token.includes('getCallerIdentity')) return { accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/test', userId: 'test' };
      if (token.includes('getRegion')) return { name: 'us-east-1', region: 'us-east-1', id: 'us-east-1' };
      if (token.includes('getPartition')) return { partition: 'aws', dnsSuffix: 'amazonaws.com' };
      if (token.includes('getAuthorizationToken')) return { proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com', password: 'test', userName: 'AWS' };
      if (token.includes('getPolicyDocument')) return { json: '{}' };
      if (token.includes('getAvailabilityZones')) return { names: ['us-east-1a', 'us-east-1b'], zoneIds: ['use1-az1', 'use1-az2'] };
      return {};
    },
  }, 'app', 'dev', false);

  const g = globalThis as Record<string, unknown>;
  g.$app = { name: 'app', stage: 'dev', removal: 'remove', protect: false, providers: { aws: { region: 'us-east-1' }, 'docker-build': { version: '0.0.14' } } };
  g.$dev = false;
  g.$cli = { paths: { root: ROOT, work: path.join(ROOT, '.sst'), platform: path.join(ROOT, '.sst/platform') }, command: 'deploy', state: { version: {} } };
  g.$util = pulumi;
  g.$output = pulumi.output;
  g.$resolve = pulumi.all;
  g.$apply = pulumi.apply;
  g.$interpolate = pulumi.interpolate;
  g.$concat = pulumi.concat;
  g.$jsonParse = pulumi.jsonParse;
  g.$jsonStringify = pulumi.jsonStringify;
  g.aws = await import('@pulumi/aws');
  const component = await import('./.sst/platform/src/components/component.js');
  g.$transform = component.$transform;
  g.$asset = component.$asset;
  g.sst = await import('./.sst/platform/src/components/index.js');

  fs.writeFileSync(path.join(ROOT, '.env.dev'), 'APP_KEY=base64:test\nAPP_NAME="My App"\n');
  fs.writeFileSync(path.join(ROOT, 'deploy.sh'), '#!/bin/sh\nphp artisan migrate --force\n');
  fs.writeFileSync(path.join(ROOT, '.dockerignore'), '# user rules\nnode_modules\n.env*\ncustom-exclusion\n');

  const { LaravelService, RemoteEnvVault } = await import('./pkg/@kirschbaum-development/sst-laravel/laravel-sst.js');
  const sst = g.sst as any;

  await pulumi.runtime.runInPulumiStack(async () => {
    pulumi.runtime.registerStackTransformation((args) => {
      const recorded = resources.get(args.name) ?? { type: args.type, name: args.name, inputs: {} };
      recorded.parent = (args.opts.parent as any)?.__name;
      recorded.retainOnDelete = args.opts.retainOnDelete;
      // `rootStackResource` is undefined: an alias with a `parent` key set to
      // it means the root stack, one without the key the current parent.
      recorded.aliases = (args.opts.aliases as any[] | undefined)?.map((alias) =>
        typeof alias === 'string'
          ? alias
          : JSON.stringify({
              ...alias,
              ...('parent' in alias ? { parent: alias.parent?.__name ?? 'root stack' } : {}),
            }),
      );
      const dependsOn = [args.opts.dependsOn ?? []].flat() as any[];
      recorded.dependsOn = dependsOn.length ? dependsOn.map((resource) => resource.__name).sort() : undefined;
      resources.set(args.name, recorded);
      return undefined;
    });

    // Everything at once: domains, load balancer options, background tasks,
    // several workers, Reverb, an env file with a linked database, and
    // `vars` given as an Output.
    full = new LaravelService('Full', {
      vpc,
      link: [
        new sst.Linkable('FullDatabase', {
          properties: { provider: 'planetscale', host: 'db.example.com', database: 'app', username: 'app', password: 'secret' },
        }),
      ],
      permissions: [{ actions: ['s3:GetObject'], resources: ['*'] }],
      config: {
        php: 8.3,
        environment: { file: '.env.dev', vars: pulumi.output({ FROM_OUTPUT: 'yes' }) },
        deployment: { script: 'deploy.sh' },
      },
      web: {
        size: 'medium',
        horizon: true,
        accessLogs: false,
        healthCheck: { path: '/up' },
        domain: { name: 'example.com', dns: false, cert },
        loadBalancer: { ingressCidrs: ['10.0.0.0/8', '2400:cb00::/32'], accessLogs: true },
      },
      workers: [
        { name: 'queue', horizon: true, scheduler: true, size: 'small' },
        { name: 'pulse', tasks: { pulse: { command: 'php artisan pulse:work' } }, advanced: { architecture: 'arm64' } },
      ],
      reverb: { domain: { name: 'ws.example.com', dns: false, cert } },
    });

    // The environment from AWS Secrets Manager.
    new LaravelService('Vault', {
      vpc,
      config: { environment: { secrets: new RemoteEnvVault('VaultEnv') } },
      web: {},
    });

    // The smallest app: one web container, no environment file.
    new LaravelService('Mini', { vpc, web: {} });

    // An sst.aws.Vpc without NAT: containers in the public subnets, with a public IP.
    new LaravelService('Net', { vpc: new sst.aws.Vpc('NetVpc'), web: {}, workers: [{ name: 'queue' }] });

    // A worker behind its own load balancer, OPcache off.
    new LaravelService('Custom', {
      vpc,
      config: { opcache: false },
      workers: [{
        name: 'api',
        advanced: {
          loadBalancer: { ports: [{ listen: '80/http', forward: '8080/http' }] },
          transform: {
            image: (args: any, opts: pulumi.CustomResourceOptions) => {
              args.labels = { 'user-image-hook': 'preserved' };
              opts.customTimeouts = { create: '30m' };
            },
            service: { deploymentMinimumHealthyPercent: 50 },
          },
        },
      }],
    });

    await settle();
  });
});

/** Unwraps Pulumi secrets and parses JSON strings, so snapshot diffs are readable. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;

    if (object[SECRET_SIG]) {
      return { secret: normalize(object.value) };
    }

    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, normalize(object[key])]),
    );
  }

  if (typeof value === 'string' && /^[[{]/.test(value)) {
    try {
      return normalize(JSON.parse(value));
    } catch {
      return value;
    }
  }

  return value;
}

/** The resources of one scenario: the names SST prefixes with its name. */
function snapshot(prefix: string): string {
  const entries = [...resources.values()]
    .filter((resource) => resource.name.startsWith(prefix))
    .sort((a, b) => `${a.type} ${a.name}`.localeCompare(`${b.type} ${b.name}`))
    .map(({ inputs, ...resource }) => ({ ...resource, inputs: normalize(inputs) }));

  return JSON.stringify(entries, null, 2)
    .replaceAll(ROOT, '<root>')
    // The random suffix SST adds to physical names (8 of its "pretty" letters).
    .replace(/-[abcdefhkmnorstuvwxz]{8}(?![A-Za-z0-9])/g, '-<random>')
    + '\n';
}

function find(type: string, name: string): Recorded {
  const resource = resources.get(name);
  expect(resource?.type, `${type} ${name}`).toBe(type);
  return resource!;
}

function containerEnvironment(taskDefinition: string): Record<string, string> {
  const definitions = normalize(find('aws:ecs/taskDefinition:TaskDefinition', taskDefinition).inputs.containerDefinitions) as any;
  const container = (definitions.secret ?? definitions)[0];

  return Object.fromEntries(container.environment.map((variable: any) => [variable.name, variable.value]));
}

function buildArgs(image: string): Record<string, string> {
  return find('docker-build:index:Image', image).inputs.buildArgs as Record<string, string>;
}

describe.each(['Full', 'Vault', 'Mini', 'Net', 'Custom'])('%s resources', (scenario) => {
  it('match the snapshot', async () => {
    await expect(snapshot(scenario)).toMatchFileSnapshot(
      path.join(SNAPSHOTS, `${scenario.toLowerCase()}.json`),
    );
  });
});

describe('nodes', () => {
  it('exposes the cluster and every service', () => {
    expect(full.nodes.cluster.constructor.name).toBe('Cluster');
    expect(full.nodes.web.constructor.name).toBe('Service');
    expect(full.nodes.reverb.constructor.name).toBe('Service');
    expect(Object.keys(full.nodes.workers)).toEqual(['queue', 'pulse']);
  });

  it('exports the exact managed service and task definition ARNs for verification', async () => {
    const deployment = await new Promise<any>((resolve) => pulumi.output(full.deployment).apply(resolve));
    expect(deployment).toMatchObject({ version: 1, app: 'app', stage: 'dev', taskDefinitions: [] });
    expect(deployment.services).toHaveLength(4);
    expect(deployment.services.map((service: any) => service.taskDefinition)).toEqual([
      'arn:aws:mock:us-east-1:123456789012:Full-WebTask',
      'arn:aws:mock:us-east-1:123456789012:Full-queueTask',
      'arn:aws:mock:us-east-1:123456789012:Full-pulseTask',
      'arn:aws:mock:us-east-1:123456789012:Full-ReverbTask',
    ]);
  });
});

describe('deployed configuration', () => {
  it('keeps existing provider settings and user Docker ignore rules', () => {
    expect((globalThis as any).$app.providers).toEqual({ aws: { region: 'us-east-1' }, 'docker-build': { version: '0.0.14' } });
    expect(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')).toBe('# user rules\nnode_modules\n.env*\ncustom-exclusion\n\n# sst\n.sst\n\n# sst-laravel\n!.sst/laravel\n');
  });
  it('retains built images, without retaining ECS services or task definitions', () => {
    for (const resource of resources.values()) {
      if (resource.type === 'docker-build:index:Image') expect(resource.retainOnDelete).toBe(true);
      if (resource.type.startsWith('aws:ecs/')) expect(resource.retainOnDelete).not.toBe(true);
    }
  });

  it('composes user image and service hooks through SST', () => {
    expect(find('docker-build:index:Image', 'Custom-apiImageCustom-api').inputs.labels).toEqual({ 'user-image-hook': 'preserved' });
    expect(find('aws:ecs/service:Service', 'Custom-apiService').inputs.deploymentMinimumHealthyPercent).toBe(50);
  });

  it('passes the SST-selected provider Check RPC with the real generated image inputs', async () => {
    for (const name of ['Full-WebImageFull-Web', 'Full-queueImageFull-queue']) {
      const inputs = find('docker-build:index:Image', name).inputs;
      // Credentials are irrelevant to Check; never pass or report registry secrets.
      const { context, dockerfile, buildArgs, target, platforms } = inputs;
      expect(await checkImageInputs({ context, dockerfile, buildArgs, target, platforms, push: false })).toEqual([]);
    }
  });

  it('reproduces the old COPY --exclude failure in provider 0.0.14', async () => {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, '.sst/platform/package.json'), 'utf8')).dependencies['@pulumi/docker-build'];
    if (version !== '0.0.14') return;
    const failures = await checkImageInputs({ context: { location: ROOT }, dockerfile: {
      inline: '# syntax=docker/dockerfile:1\nFROM scratch\nCOPY --exclude=.sst . /app\n',
    }, push: false });
    expect(failures.some((failure: any) => /exclude/.test(failure.reason))).toBe(true);
  });
  it('passes config.environment.vars to the containers when it is an Output', () => {
    expect(containerEnvironment('Full-WebTask')).toMatchObject({
      FROM_OUTPUT: 'yes',
      NGINX_ACCESS_LOG: '/dev/null',
      REVERB_HOST: 'ws.example.com',
    });
    expect(containerEnvironment('Full-queueTask')).toMatchObject({ FROM_OUTPUT: 'yes', REVERB_HOST: 'ws.example.com' });
    expect(containerEnvironment('Full-queueTask')).not.toHaveProperty('NGINX_ACCESS_LOG');
  });

  it('builds the deploy stage with OPcache on unless config.opcache is false', () => {
    expect(find('docker-build:index:Image', 'Full-WebImageFull-Web').inputs.target).toBe('deploy');
    expect(buildArgs('Full-WebImageFull-Web')).toMatchObject({ PHP_OPCACHE_ENABLE: '1', PHP_VERSION: '8.3' });
    expect(buildArgs('Full-queueImageFull-queue')).toMatchObject({ PHP_OPCACHE_ENABLE: '1' });
    expect(buildArgs('Custom-apiImageCustom-api')).toMatchObject({ PHP_OPCACHE_ENABLE: '0' });
  });

  it('gives each component its own build folder', () => {
    expect(buildArgs('Full-WebImageFull-Web').DEPLOY_PATH).toBe('/pkg/@kirschbaum-development/laravel/Full/deploy');
    expect(buildArgs('Mini-WebImageMini-Web').DEPLOY_PATH).toBe('/pkg/@kirschbaum-development/laravel/Mini/deploy');
    expect(buildArgs('Full-WebImageFull-Web').CUSTOM_CONF_PATH).not.toBe(buildArgs('Mini-WebImageMini-Web').CUSTOM_CONF_PATH);
  });

  it('copies the worker s6 config from the build folder, not node_modules', () => {
    const confPath = buildArgs('Full-queueImageFull-queue').CONF_PATH;

    expect(confPath).not.toContain('node_modules');
    expect(fs.existsSync(path.join(ROOT, confPath, 'usr/local/bin/s6-install.sh'))).toBe(true);
    expect(buildArgs('Full-ReverbImageFull-Reverb').CONF_PATH).toBe(confPath);
  });

  it('writes the env file with a resource the images wait for', () => {
    const envFile = find('pulumi-nodejs:dynamic:Resource', 'Full-EnvFile.sst.aws.EnvFile');

    expect(envFile.parent).toBe('Full');
    expect(envFile.inputs).toMatchObject({ sourcePath: path.join(ROOT, '.env.dev'), autoInject: true, appUrl: 'https://example.com' });
    expect(find('docker-build:index:Image', 'Full-WebImageFull-Web').dependsOn).toEqual(['Full-EnvFile.sst.aws.EnvFile']);
  });

  it('keeps the RemoteEnvVault env file where earlier versions created it', () => {
    const remoteEnv = find('pulumi-nodejs:dynamic:Resource', 'Vault-RemoteEnv.sst.aws.EnvFile');

    expect(remoteEnv.parent).toBe('Vault');
    expect(remoteEnv.aliases).toEqual([
      JSON.stringify({ name: 'Vault-RemoteEnv.sst.aws.RemoteEnvFile' }),
      JSON.stringify({ name: 'Vault-RemoteEnv.sst.aws.RemoteEnvFile', parent: 'root stack' }),
    ]);
  });
});
