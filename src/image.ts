import * as path from 'path';
import { Input, output } from '@pulumi/pulumi';

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
      ...(options.confPath ? { CONF_PATH: relative(options.confPath) } : {}),
      CUSTOM_CONF_PATH: relative(options.servicesPath),
      DEPLOY_PATH: relative(options.deployPath),
    },
  };
}
