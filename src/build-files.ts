import * as fs from 'fs';
import * as path from 'path';

/**
 * Copies the deployment script (`config.deployment.script`) to where the
 * images pick it up, `<deployPath>/60-deploy.sh`. Without one, it writes a
 * script that does nothing, so the Docker COPY step never fails.
 */
export function stageDeploymentScript(absSitePath: string, script: string | undefined, deployPath: string): void {
  const destination = path.resolve(deployPath, '60-deploy.sh');

  fs.mkdirSync(deployPath, { recursive: true });

  if (script) {
    const source = path.resolve(absSitePath, script);

    if (fs.existsSync(source)) {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o755);
      return;
    }
  }

  fs.writeFileSync(destination, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(destination, 0o755);
}

/**
 * Runs when a container starts, before ServerSideUp's Laravel automations
 * (which end the worker image's entrypoint loop) and the deployment script.
 * When ECS sets the app's variables (`SST_LARAVEL_ENV_KEYS` lists them), it
 * writes them to `.env` as well, quoted the way `toEnvFileContent` quotes
 * them, so code and shells that read the file find what they did when the
 * image carried it. The images source it, so it returns instead of exiting.
 */
export const ENVIRONMENT_SCRIPT = `#!/bin/sh
# Written by sst-laravel. ECS sets the app's environment variables; this
# writes them to the app's .env too, on the running container only.
if [ -n "$SST_LARAVEL_ENV_KEYS" ]; then
php <<'PHP' || return 1
<?php
$lines = [];
foreach (explode(',', getenv('SST_LARAVEL_ENV_KEYS')) as $key) {
    $value = getenv($key);
    if ($key === '' || $value === false) {
        continue;
    }
    if (!preg_match('/[\\s"\\'$\\\\\\\\#]/', $value)) {
        $lines[] = "$key=$value";
    } elseif (strpbrk($value, "'\\r\\n") === false) {
        $lines[] = "$key='$value'";
    } else {
        $lines[] = $key . '="' . str_replace(['\\\\', '$', '"'], ['\\\\\\\\', '\\\\$', '\\\\"'], $value) . '"';
    }
}
$path = (getenv('APP_BASE_DIR') ?: '/var/www/html') . '/.env';
if (file_put_contents($path, implode("\\n", $lines) . "\\n") === false || !chmod($path, 0600)) {
    fwrite(STDERR, "sst-laravel: could not write $path\\n");
    exit(1);
}
PHP
fi
`;

/** Writes `ENVIRONMENT_SCRIPT` where the images copy it from. */
export function stageEnvironmentScript(deployPath: string): void {
  const destination = path.resolve(deployPath, '45-sst-laravel-env.sh');

  fs.mkdirSync(deployPath, { recursive: true });
  fs.writeFileSync(destination, ENVIRONMENT_SCRIPT);
  fs.chmodSync(destination, 0o755);
}

/**
 * Copies the package's `conf` folder (the s6-overlay installer and the
 * entrypoint) into the build directory the worker image copies it from. The
 * s6 services are generated per service by `writeS6TaskFiles`.
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
