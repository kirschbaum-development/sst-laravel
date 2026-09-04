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
  loadBalancer?: unknown;
  /**
   * Transform the underlying ECS Service resources.
   *
   * `image` and `taskDefinition` are managed internally and cannot be
   * overridden here.
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
  'loadBalancer',
  'transform',
] as const;

export type DeprecatedTopLevelKey = (typeof DEPRECATED_TOP_LEVEL_KEYS)[number];

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
  T extends { advanced?: Record<string, unknown> } & Partial<
    Record<DeprecatedTopLevelKey, unknown>
  >,
>(config?: T): Record<string, unknown> {
  if (!config) {
    return {};
  }

  const result: Record<string, unknown> = {};
  const advanced = config.advanced ?? {};

  for (const key of DEPRECATED_TOP_LEVEL_KEYS) {
    const topLevel = (config as Record<string, unknown>)[key];
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
