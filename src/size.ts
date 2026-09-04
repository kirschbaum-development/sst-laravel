/**
 * T-shirt sizes for `web`, `workers[]`, and `reverb` containers.
 *
 * Each size maps to a valid Fargate cpu/memory pair. Setting `cpu` or
 * `memory` directly always wins over `size`, so you can start with a size
 * and fine-tune later.
 *
 * Rough cost per always-on task in us-east-1 (x86):
 * - small:  0.5 vCPU / 1 GB — about $18/month
 * - medium: 1 vCPU / 2 GB   — about $36/month
 * - large:  2 vCPU / 4 GB   — about $72/month
 *
 * The load balancer (~$16/month) and VPC (~$0.50/month) are extra and shared
 * by all services.
 */
export const SERVICE_SIZES = {
  small: { cpu: '0.5 vCPU', memory: '1 GB' },
  medium: { cpu: '1 vCPU', memory: '2 GB' },
  large: { cpu: '2 vCPU', memory: '4 GB' },
} as const;

export type ServiceSize = keyof typeof SERVICE_SIZES;

export interface SizedServiceConfig {
  size?: unknown;
  cpu?: unknown;
  memory?: unknown;
}

/**
 * Returns the cpu/memory defaults for a `size`. Explicit `cpu`/`memory`
 * values win, so only missing keys are filled in. Returns an empty object
 * when no (plain string) size is set.
 *
 * `size` is read synchronously, so only plain strings are supported. Pulumi
 * Outputs are ignored on purpose — sizes are meant to be a simple,
 * readable default, not computed infrastructure.
 */
export function buildSizeDefaults(config?: SizedServiceConfig): {
  cpu?: string;
  memory?: string;
} {
  if (!config || typeof config.size !== 'string') {
    return {};
  }

  const defaults = SERVICE_SIZES[config.size as ServiceSize];

  if (!defaults) {
    throw new Error(
      `Invalid size "${config.size}". Use one of: ${Object.keys(SERVICE_SIZES).join(', ')}.`,
    );
  }

  return {
    ...(config.cpu === undefined ? { cpu: defaults.cpu } : {}),
    ...(config.memory === undefined ? { memory: defaults.memory } : {}),
  };
}
