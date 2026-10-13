import * as path from 'path';
import { CustomResourceOptions, Input, output, Resource } from '@pulumi/pulumi';
import { composeTransform } from './service-args.js';

/** Additional extension names, passed as words to install-php-extensions. */
export function serializePhpExtensions(extensions: string[]): string {
  if (!Array.isArray(extensions) || extensions.some((extension) =>
    typeof extension !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(extension))) {
    throw new Error('config.phpExtensions must be an array of PHP extension names, such as ["imagick", "pdo_pgsql"].');
  }

  return [...new Set(extensions)].join(' ');
}

/**
 * Each entry gets its own shell, like separate shell-form RUN instructions.
 * Quoting preserves the command verbatim until that shell executes it; &&
 * stops the build if an entry fails, even if later entries would succeed.
 */
export function serializeBuildCommands(commands: string[]): string {
  if (!Array.isArray(commands) || commands.some((command) =>
    typeof command !== 'string' || !command.trim() || command.includes('\0'))) {
    throw new Error('config.buildCommands must be an array of non-empty shell commands without null bytes.');
  }

  return commands.map((command) => `/bin/sh -c '${command.replace(/'/g, "'\\''")}'`).join(' && ');
}

/** Only built images are retained: deleting a shared digest can break the replacement. */
export function managedImageTransform(environmentFile?: Resource, user?: unknown) {
  return (args: object, opts: CustomResourceOptions, name: string): undefined => {
    opts.retainOnDelete ??= true;
    composeTransform(() => {}, user)(args, opts, name);

    // Keep the user's dependencies as well as the file the build must wait for.
    if (environmentFile) {
      const dependencies = opts.dependsOn ?? [];
      opts.dependsOn = Array.isArray(dependencies)
        ? [...dependencies, environmentFile]
        : output<Resource | Input<Resource>[]>(dependencies).apply((resolved) => [...(Array.isArray(resolved) ? resolved : [resolved]), environmentFile]);
    }

    return undefined;
  };
}

export interface ImageOptions {
  /** `web` builds `Dockerfile.web`, `worker` builds `Dockerfile.worker`. */
  role: 'web' | 'worker';
  /** The app folder, the Docker build context. */
  sitePath: Input<string>;
  /** The app folder as an absolute path. */
  absSitePath: string;
  /** Where the package is installed. */
  packagePath: string;
  php?: Input<number>;
  opcache?: Input<boolean>;
  phpExtensions?: Input<string[]>;
  buildCommands?: Input<string[]>;
  /** The generated s6 services of the service (`CUSTOM_CONF_PATH`). */
  servicesPath: string;
  /** The folder with the env file and deployment script (`DEPLOY_PATH`). */
  deployPath: string;
  /** The package's worker config, copied into the build folder (`CONF_PATH`). */
  confPath?: string;
}

/**
 * The image of an `sst.aws.Service`. Every build arg needs a matching `ARG`
 * in the deploy stage of the Dockerfile, or Docker drops it.
 */
export function buildImage(options: ImageOptions) {
  // Paths in the Dockerfile are relative to the build context.
  const relative = (absolute: string) => absolute.replace(options.absSitePath, '');

  return {
    context: options.sitePath,
    dockerfile: path
      .resolve(options.packagePath, `Dockerfile.${options.role}`)
      .replace(options.absSitePath, '.'),
    target: 'deploy',
    args: {
      PHP_VERSION: (options.php ?? 8.4).toString(),
      PHP_OPCACHE_ENABLE: output(options.opcache).apply((opcache) => (opcache === false ? '0' : '1')),
      ...(options.phpExtensions !== undefined ? { PHP_EXTENSIONS: output(options.phpExtensions).apply(serializePhpExtensions) } : {}),
      ...(options.buildCommands !== undefined ? { BUILD_COMMANDS: output(options.buildCommands).apply(serializeBuildCommands) } : {}),
      ...(options.confPath ? { CONF_PATH: relative(options.confPath) } : {}),
      CUSTOM_CONF_PATH: relative(options.servicesPath),
      DEPLOY_PATH: relative(options.deployPath),
    },
  };
}
