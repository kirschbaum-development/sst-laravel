import * as fs from 'fs';
import * as path from 'path';

/**
 * Copies the package's `conf` folder (the s6-overlay installer, the
 * entrypoint, and the Horizon and scheduler services) into the build
 * directory the worker image copies it from.
 *
 * The image can't copy it from the package itself: the package lives in
 * `node_modules`, which the project's `.dockerignore` usually leaves out of
 * the build context, while `.sst/laravel` is always kept. The directory is
 * wiped first so files removed from the package don't linger.
 */
export function stageWorkerConf(packagePath: string, buildPath: string): void {
  fs.rmSync(buildPath, { recursive: true, force: true });
  fs.cpSync(path.resolve(packagePath, 'conf'), buildPath, { recursive: true });
}
