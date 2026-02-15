import * as path from 'path';

/**
 * Environment variables set by the CLI to pass configuration to the SST component.
 * These are prefixed with SST_LARAVEL_ to avoid collisions.
 */
export const SST_LARAVEL_ENV = {
  PACKAGE_ROOT: 'SST_LARAVEL_PACKAGE_ROOT',
} as const;

/**
 * Get the root path of the @kirschbaum-development/sst-laravel package.
 *
 * When invoked via the CLI, this reads from the SST_LARAVEL_PACKAGE_ROOT env var.
 * Otherwise, falls back to resolving from node_modules relative to __dirname
 * (which SST sets to .sst/platform/).
 */
export function getPackagePath(): string {
  if (process.env[SST_LARAVEL_ENV.PACKAGE_ROOT]) {
    return process.env[SST_LARAVEL_ENV.PACKAGE_ROOT]!;
  }

  return path.resolve(__dirname, '../../node_modules/@kirschbaum-development/sst-laravel');
}
