import * as path from 'path';
import type { Input } from '@pulumi/pulumi';
import type {
  LaravelArgs,
  LaravelBackgroundTasksArgs,
  LaravelLoadBalancerArgs,
  LaravelReverbArgs,
  LaravelServiceArgs,
} from '../laravel-sst';
import { assertSafeWorkerName, BackgroundTask, buildBackgroundTasks } from './background-tasks';
import { buildDefaultPublicPorts, Port } from './load-balancer';
import { assertLoadBalancerArgs } from './load-balancer-hardening';
import { buildServiceArgs, findDeprecatedTopLevelKeys, resolveAdvancedArgs } from './service-args';
import { buildSizeDefaults } from './size';
import { buildWebServerEnvironment } from './web-server';

/** The `reverb` block with its defaults filled in. */
export type ResolvedReverbArgs = LaravelReverbArgs & {
  command: string;
  host: string;
  port: number;
};

/** One `sst.aws.Service` the component creates: web, a worker, or Reverb. */
export interface ServicePlan {
  kind: 'web' | 'worker' | 'reverb';
  /** The worker's name (`name`, or `worker-<n>`), for workers. */
  workerName?: string;
  /** The block in messages: `web`, `reverb`, or `workers[<name>]`. */
  label: string;
  /** Logical name of the `sst.aws.Service`. */
  resourceName: string;
  /** The Dockerfile that builds the image. */
  image: 'web' | 'worker';
  /** Build folder for the generated s6 services, copied into the image. */
  buildPath: string;
  /** Background processes supervised by s6 in the container. */
  tasks: Record<string, BackgroundTask>;
  /** The block's `sst.aws.Service` args, without `loadBalancer` and `transform`. */
  serviceArgs: Record<string, unknown>;
  scaling: LaravelServiceArgs['scaling'];
  /** The SST load balancer config: `advanced.loadBalancer`, or the package's default. */
  loadBalancer: unknown;
  /** The block's load balancer options (`sslPolicy`, `ingressCidrs`, `accessLogs`). */
  loadBalancerOptions?: LaravelLoadBalancerArgs;
  /** The block's own `advanced.transform`. */
  transform?: Record<string, unknown>;
  /** Container variables for this service only, applied over the shared ones. */
  environment: Record<string, string>;
  devCommand: string;
}

/**
 * Fills in the defaults of the `reverb` block. `true` runs Reverb with all
 * of them.
 */
export function resolveReverbArgs(config?: boolean | LaravelReverbArgs): ResolvedReverbArgs | undefined {
  if (!config) {
    return undefined;
  }

  const reverb = typeof config === 'boolean' ? {} : config;

  return {
    ...reverb,
    command: reverb.command ?? 'php artisan reverb:start',
    host: reverb.host ?? '0.0.0.0',
    port: reverb.port ?? 8080,
  };
}

/**
 * Merges a `web`, `workers[]`, or `reverb` block into the args for the
 * underlying `sst.aws.Service`. Simple options (`size`, `cpu`, `memory`,
 * `permissions`) stay first-class; everything else lives under `advanced`
 * with the old top-level keys kept as deprecated aliases (the `advanced`
 * value wins when both are set).
 */
export function resolveBlockServiceArgs(
  label: string,
  config?: LaravelServiceArgs & LaravelBackgroundTasksArgs,
): Record<string, unknown> & { loadBalancer?: unknown; transform?: Record<string, unknown> } {
  const advanced = (config?.advanced ?? {}) as Record<string, unknown>;

  for (const key of findDeprecatedTopLevelKeys(config)) {
    if (advanced[key] === undefined && (config as Record<string, unknown>)[key] !== undefined) {
      console.warn(`[sst-laravel] ${label}.${key} is deprecated. Use ${label}.advanced.${key} instead.`);
    }
  }

  const { loadBalancer, transform, ...advancedPassthrough } = resolveAdvancedArgs(config) as Record<string, unknown> & {
    loadBalancer?: unknown;
    transform?: Record<string, unknown>;
  };

  return {
    ...buildSizeDefaults(config),
    ...buildServiceArgs(config),
    ...advancedPassthrough,
    ...(loadBalancer !== undefined ? { loadBalancer } : {}),
    ...(transform !== undefined ? { transform } : {}),
  };
}

export interface PlanServicesOptions {
  /** The app folder, `args.path`. */
  sitePath: Input<string>;
  /** Where the component writes its build files (`.sst/laravel/<name>`). */
  buildPath: string;
  reverb?: ResolvedReverbArgs;
}

/**
 * Works out every service the component creates, in creation order: web,
 * the workers, then Reverb. Checks the options first, so a mistake fails the
 * deploy before anything is created or written.
 */
export function planServices(name: string, args: LaravelArgs, options: PlanServicesOptions): ServicePlan[] {
  const { sitePath, buildPath, reverb } = options;

  // The name is also the component's build folder.
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error(`Invalid LaravelService name "${name}": names must not contain "/" or "\\".`);
  }

  const workers = (args.workers ?? []).map((worker, index) => ({
    worker,
    workerName: (worker.name || `worker-${index + 1}`) as string,
  }));

  const blocks: [string, LaravelServiceArgs | undefined][] = [
    ['web', args.web],
    ['reverb', reverb],
    ...workers.map(({ worker, workerName }): [string, LaravelServiceArgs] => [`workers[${workerName}]`, worker]),
  ];

  for (const [label, config] of blocks) {
    assertLoadBalancerArgs(label, config?.loadBalancer, resolveAdvancedArgs(config).loadBalancer);
  }

  workers.forEach(({ workerName }, index) => {
    assertSafeWorkerName(workerName);

    if (workers.findIndex((other) => other.workerName === workerName) !== index) {
      throw new Error(`Two workers are named "${workerName}". Give each worker its own name.`);
    }
  });

  const plans: ServicePlan[] = [];

  if (args.web) {
    const web = args.web;
    const { loadBalancer, transform, ...serviceArgs } = resolveBlockServiceArgs('web', web);

    plans.push({
      kind: 'web',
      label: 'web',
      resourceName: `${name}-Web`,
      image: 'web',
      buildPath: path.resolve(buildPath, 'web'),
      tasks: buildBackgroundTasks(web),
      serviceArgs,
      scaling: web.scaling,
      loadBalancer: loadBalancer
        ? loadBalancer
        : {
            domain: web.domain,
            ports: buildDefaultPublicPorts({
              hasDomain: Boolean(web.domain),
              httpsRedirect: web.httpsRedirect ?? true,
            }),
            ...(web.healthCheck ? { health: { '8080/http': web.healthCheck } } : {}),
          },
      loadBalancerOptions: web.loadBalancer,
      transform,
      environment: buildWebServerEnvironment({ accessLogs: web.accessLogs }),
      devCommand: `php ${sitePath}/artisan serve`,
    });
  }

  for (const { worker, workerName } of workers) {
    const resourceName = `${name}-${workerName}`;
    const { loadBalancer, transform, ...serviceArgs } = resolveBlockServiceArgs(`workers[${workerName}]`, worker);

    plans.push({
      kind: 'worker',
      workerName,
      label: `workers[${workerName}]`,
      resourceName,
      image: 'worker',
      buildPath: path.resolve(buildPath, `worker-${workerName}`),
      tasks: buildBackgroundTasks(worker),
      serviceArgs,
      scaling: worker.scaling,
      loadBalancer,
      loadBalancerOptions: worker.loadBalancer,
      transform,
      environment: {},
      devCommand: `php ${sitePath}/artisan horizon`,
    });
  }

  if (reverb) {
    const { loadBalancer, transform, ...serviceArgs } = resolveBlockServiceArgs('reverb', reverb);
    const reverbPort: Port = `${reverb.port}/http`;

    plans.push({
      kind: 'reverb',
      label: 'reverb',
      resourceName: `${name}-Reverb`,
      image: 'worker',
      buildPath: path.resolve(buildPath, 'worker-reverb'),
      tasks: buildBackgroundTasks({
        ...reverb,
        tasks: { 'laravel-reverb': { command: reverb.command } },
      }),
      serviceArgs,
      scaling: reverb.scaling,
      loadBalancer: loadBalancer ?? {
        domain: reverb.domain,
        ports: buildDefaultPublicPorts({
          hasDomain: Boolean(reverb.domain),
          forwardPort: reverb.port,
        }),
        health: {
          [reverbPort]: {
            path: '/apps',
            successCodes: '200-499',
          },
        },
      },
      loadBalancerOptions: reverb.loadBalancer,
      transform,
      environment: {},
      devCommand: `php ${sitePath}/artisan reverb:start`,
    });
  }

  return plans;
}
