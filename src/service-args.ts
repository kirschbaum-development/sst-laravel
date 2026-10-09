import { Input, output } from '@pulumi/pulumi';

/**
 * Escape hatch for SST experts. Everything in here is passed straight to the
 * underlying `sst.aws.Service` without changes. You only need this when the
 * simple options (`cpu`, `memory`, `scaling`, `permissions`, `domain`,
 * `healthCheck`) are not enough.
 *
 * Prefer the simple options. Use `advanced` only when you know what the SST
 * Service does with the value.
 */
export interface LaravelAdvancedArgs {
  architecture?: unknown;
  storage?: unknown;
  logging?: unknown;
  /**
   * Container-level health check (runs inside the container).
   * This is different from `healthCheck`, which is the load balancer check
   * that pings a URL path like `/up`.
   */
  health?: unknown;
  executionRole?: unknown;
  /**
   * The SST load balancer config (`rules`, `domain`, `health`, ...). It
   * replaces the load balancer the package sets up. To tune that one
   * instead, use the `loadBalancer` options on the block.
   */
  loadBalancer?: unknown;
  /**
   * Transform the underlying ECS Service resources.
   *
   * `taskDefinition` is managed internally and cannot be overridden here.
   * Image transforms run after the retention default; the environment-file
   * dependency is always preserved. Setting opts.retainOnDelete = false
   * explicitly accepts the risk of deleting a replacement's shared digest.
   * Transforms for the load balancer run after the
   * `loadBalancer` options (`sslPolicy`, `ingressCidrs`, `accessLogs`).
   */
  transform?: unknown;
}

/**
 * Keys that used to be set directly on a `web`, `workers[]`, or `reverb`
 * block but now live under `advanced`. They still work in the old place for
 * existing projects, but new code should use `advanced.*`.
 */
export const DEPRECATED_TOP_LEVEL_KEYS = [
  'architecture',
  'storage',
  'logging',
  'health',
  'executionRole',
  'transform',
] as const;

export type DeprecatedTopLevelKey = (typeof DEPRECATED_TOP_LEVEL_KEYS)[number];

/**
 * Everything the `advanced` block takes. `loadBalancer` has no top-level
 * alias: on the block itself, `loadBalancer` holds the load balancer options
 * (`sslPolicy`, `ingressCidrs`, `accessLogs`).
 */
export const ADVANCED_KEYS = [
  ...DEPRECATED_TOP_LEVEL_KEYS,
  'loadBalancer',
] as const;

/**
 * The subset of `sst.aws.Service` arguments that stay first-class on a `web`,
 * `workers[]`, or `reverb` config block. These are pure passthroughs — the
 * component does not transform them, it only relays them to the underlying
 * service so options like `cpu`/`memory` actually take effect.
 */
export const FORWARDED_SERVICE_ARG_KEYS = [
  'cpu',
  'memory',
  'permissions',
] as const;

export type ForwardedServiceArgKey = (typeof FORWARDED_SERVICE_ARG_KEYS)[number];

/**
 * Picks the passthrough service arguments from a service config block so they
 * can be spread into the `sst.aws.Service` args. Only keys that are actually
 * set are returned, so spreading the result never overrides a service default
 * with an explicit `undefined`.
 */
export function buildServiceArgs<
  T extends Partial<Record<ForwardedServiceArgKey, unknown>>,
>(config?: T): Pick<T, ForwardedServiceArgKey> {
  const result = {} as Pick<T, ForwardedServiceArgKey>;

  if (!config) {
    return result;
  }

  for (const key of FORWARDED_SERVICE_ARG_KEYS) {
    if (config[key] !== undefined) {
      result[key] = config[key] as T[ForwardedServiceArgKey];
    }
  }

  return result;
}

/**
 * Merges the `advanced` block with the deprecated top-level keys.
 * Values in `advanced` win over the same key set directly on the block.
 */
export function resolveAdvancedArgs<
  T extends { advanced?: LaravelAdvancedArgs } & Partial<
    Record<DeprecatedTopLevelKey, unknown>
  >,
>(config?: T): Record<string, unknown> {
  if (!config) {
    return {};
  }

  const result: Record<string, unknown> = {};
  const advanced = config.advanced ?? {};

  for (const key of ADVANCED_KEYS) {
    const topLevel = (DEPRECATED_TOP_LEVEL_KEYS as readonly string[]).includes(
      key,
    )
      ? (config as Record<string, unknown>)[key]
      : undefined;
    const advancedValue = (advanced as Record<string, unknown>)[key];

    if (advancedValue !== undefined) {
      result[key] = advancedValue;
    } else if (topLevel !== undefined) {
      result[key] = topLevel;
    }
  }

  return result;
}

/**
 * Lists the deprecated top-level keys actually used on a config block, so the
 * component can warn once per block.
 */
export function findDeprecatedTopLevelKeys<
  T extends Partial<Record<DeprecatedTopLevelKey, unknown>>,
>(config?: T): DeprecatedTopLevelKey[] {
  if (!config) {
    return [];
  }

  return DEPRECATED_TOP_LEVEL_KEYS.filter(
    (key) => (config as Record<string, unknown>)[key] !== undefined,
  );
}

/**
 * Combines an internal resource transform with the user's own transform from
 * `advanced.transform`. The internal one runs first, so the user's function or
 * object still has the last word. Objects are shallow-merged into the args,
 * the same way SST applies an object transform.
 */
export function composeTransform<T extends object>(
  internal: (args: T, opts: unknown, name: string) => void,
  user?: unknown,
): (args: T, opts: unknown, name: string) => undefined {
  return (args, opts, name) => {
    internal(args, opts, name);

    if (typeof user === 'function') {
      user(args, opts, name);
    } else if (user && typeof user === 'object') {
      Object.assign(args, user);
    }

    return undefined;
  };
}

/**
 * Combines a map of internal transforms with the user's `advanced.transform`
 * map, key by key. Keys set on both sides go through `composeTransform`, so
 * the internal transform runs first and the user's still has the last word.
 * Keys set on one side only are passed along unchanged.
 */
export function composeTransforms(
  internal: Record<
    string,
    (args: any, opts: any, name: string) => void
  >,
  user?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(user ?? {}) };

  for (const [key, transform] of Object.entries(internal)) {
    result[key] =
      user?.[key] === undefined
        ? transform
        : composeTransform(transform, user[key]);
  }

  return result;
}

/**
 * A transform that makes the resource wait for another one, when given.
 */
export function dependOn(resource?: unknown) {
  return (_args: unknown, opts: { dependsOn?: unknown }, _name: string): undefined => {
    if (resource) {
      opts.dependsOn = [resource];
    }

    return undefined;
  };
}

/**
 * The `taskDefinition` transform of every service. It turns off the ECS init
 * process: the images run s6-overlay, which has to be PID 1.
 */
export function disableInitProcess(args: { containerDefinitions: Input<string> }): undefined {
  args.containerDefinitions = output(args.containerDefinitions).apply((definitions) =>
    JSON.stringify([
      {
        ...JSON.parse(definitions)[0],
        linuxParameters: {
          initProcessEnabled: false,
        },
      },
    ]),
  );

  return undefined;
}
