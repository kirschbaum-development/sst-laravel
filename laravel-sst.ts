/// <reference path="./../../../.sst/platform/config.d.ts" />

import * as path from 'path';
import * as fs from 'fs';
import { Component } from '../../../.sst/platform/src/components/component.js';
import { FunctionArgs } from '../../../.sst/platform/src/components/aws/function.js';
import {
    ComponentResourceOptions,
    Input as PulumiInput,
    Output,
    all,
    output,
    runtime,
} from '@pulumi/pulumi';
import { Input } from '../../../.sst/platform/src/components/input.js';
import { ClusterArgs } from '../../../.sst/platform/src/components/aws/cluster.js';
import { ServiceArgs } from '../../../.sst/platform/src/components/aws/service.js';
import { Dns } from '../../../.sst/platform/src/components/dns.js';
import {
    applyLinkedResourcesEnv,
    EnvCallback,
    EnvCallbacks,
    extractSecrets,
} from './src/laravel-env';
import { RemoteEnvVault, RemoteEnvVaultArgs } from './src/laravel-env-manager';
import { getPackagePath } from './src/config';
import { RemoteEnvFile } from './src/remote-env-file';
import { buildReverbEnvironmentVariables } from './src/reverb';
import { getSecretsFingerprint } from './src/secrets-manager';
import { buildDefaultPublicPorts, Port } from './src/load-balancer';
import { buildWebServerEnvironment } from './src/web-server';
import { buildServiceArgs } from './src/service-args';
import {
    assertSafeWorkerName,
    buildBackgroundTasks,
    writeS6TaskFiles,
} from './src/background-tasks';

// Re-export RemoteEnvVault for external use
export { RemoteEnvVault, RemoteEnvVaultArgs };

enum ImageType {
    Web = 'web',
    Worker = 'worker',
    Cli = 'cli',
}

export type LaravelDomain = Input<
    | string
    | {
          /**
           * Domain name. You are able to use variables from the SST config file here.
           *
           * @example
           * ```js
           * domain: {
           *   name: `${$app.stage}.example.com`,
           * }
           * ```
           */
          name: Input<string>;

          /**
           * Certificate ARN. Use this in case you are manually setting up the SSL certificate.
           * This is usually needed when your DNS is not in the same AWS account or is outside of AWS.
           *
           * @example
           * ```js
           * domain: {
           *   cert: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012',
           * }
           * ```
           */
          cert?: Input<string>;

          /**
           * SST DNS configuration. You can use this configuration if your DNS is in Cloudflare or another AWS account.
           *
           * @see https://sst.dev/docs/component/cloudflare/dns/
           * @see https://sst.dev/docs/component/aws/dns/
           * @example
           * ```js
           * domain: {
           *   dns: sst.cloudflare.dns(),
           * }
           * ```
           */
          dns?: Input<false | (Dns & {})>;
      }
>;

export interface LaravelServiceArgs {
    architecture?: ServiceArgs['architecture'];
    cpu?: ServiceArgs['cpu'];
    memory?: ServiceArgs['memory'];
    storage?: ServiceArgs['storage'];
    loadBalancer?: ServiceArgs['loadBalancer'];
    scaling?: ServiceArgs['scaling'];
    logging?: ServiceArgs['logging'];
    health?: ServiceArgs['health'];
    executionRole?: ServiceArgs['executionRole'];
    permissions?: ServiceArgs['permissions'];

    /**
     * Transform the underlying ECS Service resources. Useful for hardening the
     * ALB (e.g. restricting the load-balancer security group to a fixed set of
     * upstream CIDRs) or adjusting other inner resources.
     *
     * `image` and `taskDefinition` are managed internally and cannot be
     * overridden here — they carry the env-file dependency wiring and the
     * `initProcessEnabled: false` setting required by this package.
     *
     * @example
     * ```js
     * web: {
     *   transform: {
     *     loadBalancerSecurityGroup: (sgArgs) => {
     *       sgArgs.ingress = [{
     *         protocol: "tcp",
     *         fromPort: 443,
     *         toPort: 443,
     *         cidrBlocks: ["173.245.48.0/20", "103.21.244.0/22"],
     *       }];
     *     },
     *   },
     * }
     * ```
     */
    transform?: Omit<
        NonNullable<ServiceArgs['transform']>,
        'image' | 'taskDefinition'
    >;
}

/**
 * Shorthand for the load balancer health check applied to the default forward
 * port. Mirrors the inner shape of SST's `loadBalancer.health` entry, minus the
 * per-port keying which the package fills in for you.
 *
 * Not used when {@link LaravelWebArgs.loadBalancer} is provided — in that case
 * configure `loadBalancer.health` directly.
 */
export interface LaravelHealthCheck {
    /**
     * The URL path the load balancer pings for health checks.
     * @default `"/"`
     */
    path?: Input<string>;
    /**
     * Time between health check requests. Between `5 seconds` and `300 seconds`.
     * @default `"30 seconds"`
     */
    interval?: Input<`${number} ${'second' | 'seconds' | 'minute' | 'minutes'}`>;
    /**
     * Per-request timeout. Between `2 seconds` and `120 seconds`.
     * @default `"5 seconds"`
     */
    timeout?: Input<`${number} ${'second' | 'seconds' | 'minute' | 'minutes'}`>;
    /**
     * Consecutive successes required to mark a target healthy. Between 2 and 10.
     * @default `5`
     */
    healthyThreshold?: Input<number>;
    /**
     * Consecutive failures required to mark a target unhealthy. Between 2 and 10.
     * @default `2`
     */
    unhealthyThreshold?: Input<number>;
    /**
     * HTTP response codes treated as successful (e.g. `"200"`, `"200-299"`).
     * @default `"200"`
     */
    successCodes?: Input<string>;
}

/**
 * Background processes supervised by s6-overlay inside the container.
 *
 * On `workers[]`, these run as the container's main workload; if Horizon or
 * the scheduler dies, the container halts and ECS replaces it.
 *
 * On `web`, these run alongside nginx/php-fpm. A crashed process is restarted
 * in place by s6 so HTTP traffic is never interrupted. Note that when the web
 * service scales beyond one container, every replica runs these processes —
 * Horizon tolerates this (shared queue), but scheduled jobs should use
 * `onOneServer()` backed by a shared cache store.
 */
export interface LaravelBackgroundTasksArgs {
    /**
     * Run Laravel Horizon (`php artisan horizon`).
     */
    horizon?: Input<boolean>;

    /**
     * Run the Laravel scheduler (`php artisan schedule:work`).
     */
    scheduler?: Input<boolean>;

    /**
     * Custom long-running commands, keyed by task name.
     *
     * @example
     * ```js
     * tasks: {
     *   pulse: {
     *     command: 'php artisan pulse:work',
     *   },
     * }
     * ```
     */
    tasks?: Input<{
        [key: string]: Input<{
            command: Input<string>;
            dependencies?: Input<string[]>;
        }>;
    }>;
}

export interface LaravelWebArgs
    extends LaravelServiceArgs,
        LaravelBackgroundTasksArgs {
    /**
     * Custom domain for the web layer. (if you don't provide a domain name, you will be able to use the load balancer domain for testing (http only))
     */
    domain?: LaravelDomain;

    /**
     * Load balancer health check for the web service. The package wires this
     * to the default forward port (`8080/http`), so you only specify the
     * check itself — not the per-port key.
     *
     * Distinct from {@link LaravelServiceArgs.health}, which is the ECS
     * container-level health check.
     *
     * Ignored when `loadBalancer` is set — configure `loadBalancer.health`
     * yourself in that case.
     *
     * @example
     * ```js
     * web: {
     *   healthCheck: { path: '/up' },
     * }
     * ```
     */
    healthCheck?: Input<LaravelHealthCheck>;

    /**
     * When a `domain` is configured, redirect HTTP (port 80) traffic to the
     * HTTPS (port 443) listener instead of forwarding it straight to the
     * application. Set to `false` to keep forwarding HTTP traffic to the app.
     *
     * Has no effect when no `domain` is set (there is no HTTPS listener to
     * redirect to) or when an explicit `loadBalancer` is provided (configure
     * `loadBalancer.ports` yourself in that case).
     *
     * @default `true`
     *
     * @example
     * ```js
     * web: {
     *   domain: 'example.com',
     *   httpsRedirect: false,
     * }
     * ```
     */
    httpsRedirect?: boolean;

    /**
     * Stream the nginx access logs from the web container to CloudWatch.
     *
     * The web container runs nginx (`serversideup/php:*-fpm-nginx`), which logs
     * every request — including the load balancer health-check pings — to
     * stdout. Set this to `false` to silence those access logs (it points the
     * serversideup `NGINX_ACCESS_LOG` variable at `/dev/null`). Error logs and
     * the Laravel application logs are unaffected.
     *
     * Only the web container runs nginx, so this has no effect on workers or
     * the Reverb service.
     *
     * @default `true`
     *
     * @example
     * ```js
     * web: {
     *   accessLogs: false,
     * }
     * ```
     */
    accessLogs?: boolean;
}

export interface LaravelReverbArgs extends LaravelServiceArgs {
    /**
     * Custom domain for the Reverb service. When provided, Reverb requests are routed over HTTPS to the Reverb server running on port 8080 by default.
     */
    domain?: LaravelDomain;

    /**
     * Host the Reverb server listens on inside the container.
     *
     * @default `0.0.0.0`
     */
    host?: string;

    /**
     * Port the Reverb server listens on inside the container.
     *
     * @default `8080`
     */
    port?: number;

    /**
     * Command used to start Reverb.
     *
     * @default `php artisan reverb:start`
     */
    command?: string;
}

export interface LaravelWorkerConfig
    extends LaravelServiceArgs,
        LaravelBackgroundTasksArgs {
    name?: Input<string>;
}

export interface LaravelArgs extends ClusterArgs {
    // dev?: false | DevArgs["dev"];
    path?: Input<string>;
    link?: Array<
        | any
        | {
              resource: any;
              environment?: EnvCallback;
          }
    >;

    permissions?: Array<{
        actions: string[];
        resources: string[];
    }>;

    /**
     * If enabled, a container will be created to handle HTTP traffic.
     */
    web?: LaravelWebArgs;

    /**
     * Multiple workers settings.
     */
    workers?: LaravelWorkerConfig[];

    /**
     * If enabled, a public worker-style container will be created to run Laravel Reverb.
     */
    reverb?: boolean | LaravelReverbArgs;

    /**
     * Config settings.
     */
    config?: {
        /**
         * PHP version.
         * Available versions: 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5
         *
         * @default `8.4`
         */
        php?: Input<Number>;

        /**
         * PHP Opcache should be enabled?
         *
         * @default `true`
         */
        opcache?: Input<boolean>;

        environment?: {
            /**
             * Use this option if you want to import an .env file during build. By default, SST Laravel won't use your .env file since that might be the wrong file when deploying from your local machine.
             *
             * @example
             * ```js
             * # Use use a fila named .env.$stage as your .env file
             * environment: {
             *   file: `.env.${$app.stage}`,
             * }
             * OR
             * environment: {
             *   file: `.env`,
             * }
             * ```
             */
            file?: Input<string>;

            /**
             * Set this to false in case you don't want to auto inject environment variables from your linked resources.
             *
             * @default `true`
             */
            autoInject?: Input<boolean>;

            /**
             * Custom environment variables that will be automatically injected into your application.
             *
             * @example
             * ```js
             * environment: {
             *   vars: {
             *     SESSION_DRIVER: 'redis',
             *     QUEUE_CONNECTION: 'redis',
             *   }
             * }
             * ```
             */
            vars?: FunctionArgs['environment'];

            /**
             * Use a `RemoteEnvVault` component to manage environment variables in AWS Secrets Manager.
             * When provided, secrets will be fetched from AWS Secrets Manager at build time.
             *
             * @example
             * ```js
             * const env = new RemoteEnvVault("Env");
             *
             * new LaravelService("Laravel", {
             *   config: {
             *     environment: {
             *       secrets: env,
             *     },
             *   },
             * });
             * ```
             */
            secrets?: RemoteEnvVault;
        };

        /**
         * Custom deployment configurations.
         */
        deployment?: {
            // migrate?: Input<boolean>;
            // optimize?: Input<boolean>;
            script?: Input<string>;
        };
    };
}

export class LaravelService extends Component {
    private readonly services: Record<string, sst.aws.Service>;
    private readonly _messages: string[] = [];

    constructor(
        name: string,
        args: LaravelArgs,
        opts: ComponentResourceOptions = {},
    ) {
        super(__pulumiType, name, args, opts);

        this.services = {};

        args.config = args.config ?? {};
        const sitePath = args.path ?? '.';
        const absSitePath = path.resolve(sitePath.toString());
        const nodeModulePath = getPackagePath();
        const reverbConfig = normalizeReverbConfig(args.reverb);

        // Determine the path where our plugin will save build files.
        // SST sets __dirname to the .sst/platform directory.
        const pluginBuildPath = path.resolve(__dirname, '../laravel');

        if (!fs.existsSync(pluginBuildPath)) {
            fs.mkdirSync(pluginBuildPath, { recursive: true });
        }

        if (!fs.existsSync(pluginBuildPath + '/deploy')) {
            fs.mkdirSync(pluginBuildPath + '/deploy', { recursive: true });
        }

        const envFilePath = path.resolve(pluginBuildPath, 'deploy', '.env');

        const envFileHasVariable = (variableName: string): boolean => {
            const content = fs.readFileSync(envFilePath, 'utf-8');
            return content
                .split('\n')
                .some((line) => line.trim().startsWith(`${variableName}=`));
        };

        const envFileSetVariable = (variableName: string, value: string) => {
            fs.appendFileSync(envFilePath, `\n${variableName}=${value}\n`);
            this._messages.push(
                `Added ${variableName} to environment file: ${value}`,
            );
        };

        const envFileSetVariableIfMissing = (
            variableName: string,
            value: string,
        ) => {
            if (envFileHasVariable(variableName)) {
                return;
            }

            envFileSetVariable(variableName, value);
        };

        const environmentFileDependency = prepareEnvironmentFile();
        prepareDeploymentScript();

        const addEnvironmentFileImageDependency = (
            _args: unknown,
            opts: $util.CustomResourceOptions,
            _name: string,
        ) => {
            if (!environmentFileDependency) {
                return undefined;
            }

            opts.dependsOn = [environmentFileDependency];

            return undefined;
        };

        const cluster = new sst.aws.Cluster(`${name}-Cluster`, {
            vpc: normalizeClusterVpc(args.vpc),
        });

        const addWebService = () => {
            const webBuildPath = path.resolve(pluginBuildPath, 'web');
            writeS6TaskFiles(buildBackgroundTasks(args.web ?? {}), webBuildPath);

            const envVariables = {
                ...getEnvironmentVariables(),
                ...buildWebServerEnvironment({
                    accessLogs: args.web?.accessLogs,
                }),
            };

            this.services['web'] = new sst.aws.Service(
                `${name}-Web`,
                {
                    cluster,
                    link: getLinks(),
                    permissions: args.permissions,
                    ...buildServiceArgs(args.web),

                    /**
                     * Image passed or use our default provided image.
                     */
                    image: getImage(ImageType.Web, {
                        CUSTOM_CONF_PATH: webBuildPath.replace(absSitePath, ''),
                    }),
                    environment: envVariables,
                    scaling: args.web?.scaling,

                    loadBalancer:
                        args.web && args.web.loadBalancer
                            ? args.web.loadBalancer
                            : {
                                  domain: args.web?.domain,
                                  ports: buildDefaultPublicPorts({
                                      hasDomain: Boolean(args.web?.domain),
                                      httpsRedirect:
                                          args.web?.httpsRedirect ?? true,
                                  }),
                                  ...(args.web?.healthCheck
                                      ? {
                                            health: {
                                                '8080/http': args.web.healthCheck,
                                            },
                                        }
                                      : {}),
                              },

                    dev: {
                        command: `php ${sitePath}/artisan serve`,
                    },

                    transform: {
                        ...(args.web?.transform ?? {}),
                        image: addEnvironmentFileImageDependency,
                        taskDefinition: (args) => {
                            args.containerDefinitions = (
                                args.containerDefinitions as $util.Output<string>
                            ).apply((a) => {
                                return JSON.stringify([
                                    {
                                        ...JSON.parse(a)[0],
                                        linuxParameters: {
                                            initProcessEnabled: false,
                                        },
                                    },
                                ]);
                            });
                        },
                    },
                },
                {
                    dependsOn: environmentFileDependency
                        ? [environmentFileDependency]
                        : [],
                },
            );
        };

        const createWorkerService = (
            workerConfig: LaravelWorkerConfig,
            serviceName: string,
            workerBuildPath: string,
            serviceKey = serviceName,
            devCommand = `php ${sitePath}/artisan horizon`,
        ) => {
            writeS6TaskFiles(buildBackgroundTasks(workerConfig), workerBuildPath);

            const imgBuildArgs = {
                CONF_PATH: path
                    .resolve(nodeModulePath, 'conf')
                    .replace(absSitePath, ''),
                CUSTOM_CONF_PATH: workerBuildPath.replace(absSitePath, ''),
            };

            this.services[serviceKey] = new sst.aws.Service(
                serviceName,
                {
                    cluster,
                    link: getLinks(),
                    permissions: args.permissions,
                    ...buildServiceArgs(workerConfig),

                    image: getImage(ImageType.Worker, imgBuildArgs),
                    scaling: workerConfig.scaling,
                    environment: getEnvironmentVariables(),
                    loadBalancer: workerConfig.loadBalancer,

                    dev: {
                        command: devCommand,
                    },

                    transform: {
                        ...(workerConfig.transform ?? {}),
                        image: addEnvironmentFileImageDependency,
                        taskDefinition: (args) => {
                            args.containerDefinitions = (
                                args.containerDefinitions as $util.Output<string>
                            ).apply((a) => {
                                return JSON.stringify([
                                    {
                                        ...JSON.parse(a)[0],
                                        linuxParameters: {
                                            initProcessEnabled: false,
                                        },
                                    },
                                ]);
                            });
                        },
                    },
                },
                {
                    dependsOn: environmentFileDependency
                        ? [environmentFileDependency]
                        : [],
                },
            );
        };

        function addReverbService() {
            if (!reverbConfig) {
                return;
            }

            const reverbPort: Port = `${reverbConfig.port}/http`;
            const reverbWorkerConfig: LaravelWorkerConfig = {
                ...reverbConfig,
                name: 'reverb',
                loadBalancer: reverbConfig.loadBalancer ?? {
                    domain: reverbConfig.domain,
                    ports: buildDefaultPublicPorts({
                        hasDomain: Boolean(reverbConfig.domain),
                        forwardPort: reverbConfig.port,
                    }),
                    health: {
                        [reverbPort]: {
                            path: '/apps',
                            successCodes: '200-499',
                        },
                    },
                },
                tasks: {
                    'laravel-reverb': {
                        command: reverbConfig.command,
                    },
                },
            };

            createWorkerService(
                reverbWorkerConfig,
                `${name}-Reverb`,
                path.resolve(pluginBuildPath, 'worker-reverb'),
                'reverb',
                `php ${sitePath}/artisan reverb:start`,
            );
        }

        function addWorkerServices() {
            args.workers?.forEach((workerConfig, index) => {
                const workerName = workerConfig.name || `worker-${index + 1}`;
                assertSafeWorkerName(workerName as string);
                const absWorkerBuildPath = path.resolve(
                    pluginBuildPath,
                    `worker-${workerName}`,
                );

                createWorkerService(
                    workerConfig,
                    `${name}-${workerName}`,
                    absWorkerBuildPath,
                );
            });
        }

        if (args.web) {
            addWebService();
        }

        if (args.workers) {
            addWorkerServices();
        }

        if (reverbConfig) {
            addReverbService();
        }

        function normalizeClusterVpc(
            vpc: LaravelArgs['vpc'],
        ): LaravelArgs['vpc'] {
            if (
                !vpc ||
                typeof vpc !== 'object' ||
                !('publicSubnets' in vpc) ||
                !('nodes' in vpc)
            ) {
                return vpc;
            }

            const cloudmapNamespace = vpc.nodes?.cloudmapNamespace;

            if (!cloudmapNamespace) {
                return vpc;
            }

            return {
                id: vpc.id,
                securityGroups: vpc.securityGroups,
                containerSubnets: vpc.privateSubnets,
                loadBalancerSubnets: vpc.publicSubnets,
                cloudmapNamespaceId: cloudmapNamespace.id,
                cloudmapNamespaceName: cloudmapNamespace.name,
            };
        }

        // TODO: We have to test if it works when a custom image is provided in sst.config.js
        function getImage(imgType: ImageType, extraArgs: object = {}) {
            const img = getDefaultImage(imgType, extraArgs);

            const context =
                typeof img === 'string'
                    ? sitePath.toString()
                    : (img as { context: string }).context.toString();

            const dockerfile =
                typeof img === 'string'
                    ? 'Dockerfile'
                    : (img as { dockerfile: string }).dockerfile;

            // add .sst/laravel to .dockerignore if not exist
            const dockerIgnore = (() => {
                let filePath = path.join(context, `${dockerfile}.dockerignore`);
                if (fs.existsSync(filePath)) return filePath;

                return path.join(context, '.dockerignore');
            })();

            const content = fs.existsSync(dockerIgnore)
                ? fs.readFileSync(dockerIgnore).toString()
                : '';

            const lines = content.split('\n');

            const normalizedLines = [
                ...lines.filter(
                    (line) =>
                        line !== '.sst' &&
                        line !== '!.sst/laravel' &&
                        line !== '# sst' &&
                        line !== '# sst-laravel',
                ),
                '',
                '# sst',
                '.sst',
                '',
                '# sst-laravel',
                '!.sst/laravel',
            ];

            if (normalizedLines.join('\n') !== lines.join('\n')) {
                fs.writeFileSync(dockerIgnore, normalizedLines.join('\n'));
            }

            return img;
        }

        function getDefaultImage(imageType: ImageType, extraArgs: object = {}) {
            return {
                context: sitePath,
                dockerfile: path
                    .resolve(nodeModulePath, `Dockerfile.${imageType}`)
                    .replace(absSitePath, '.'),
                args: {
                    PHP_VERSION: getPhpVersion().toString(),
                    PHP_OPCACHE_ENABLE: args.config?.opcache ? '1' : '0',
                    AUTORUN_LARAVEL_MIGRATION:
                        imageType === ImageType.Web ? 'true' : 'false',
                    CONTAINER_TYPE: imageType,
                    stage: 'deploy',
                    platform: 'linux/amd64',
                    ...extraArgs,
                },
            };
        }

        function getPhpVersion() {
            return args.config?.php ?? 8.4;
        }

        function getEnvironmentVariables() {
            const env = args.config?.environment?.vars || {};

            return {
                ...(shouldAutoInjectEnvironment()
                    ? getReverbEnvironmentVariables()
                    : {}),
                ...env,
            };
        }

        function getLinkedEnvironmentData() {
            const links = args.link || [];
            const resources: any[] = [];
            const customEnv: Record<string, string | Output<string>> = {};

            links.forEach((link) => {
                if (link && typeof link === 'object' && 'resource' in link) {
                    // Link is an object with resource and optional envCallback
                    resources.push(link.resource);

                    // If there's an envCallback, call it and merge the result
                    const callback =
                        (
                            link as {
                                environment?: EnvCallback;
                                envCallback?: EnvCallback;
                            }
                        ).environment ||
                        (
                            link as {
                                environment?: EnvCallback;
                                envCallback?: EnvCallback;
                            }
                        ).envCallback;
                    if (callback) {
                        const callbackResult = callback(link.resource);
                        Object.assign(customEnv, callbackResult);
                    }
                } else {
                    // Link is just a resource
                    resources.push(link);
                }
            });

            return {
                linkedEnvironment: {
                    ...applyLinkedResourcesEnv(resources),
                    ...customEnv,
                    ...getReverbEnvironmentVariables(),
                },
                linkedSecrets: extractSecrets(resources).map((secret) => ({
                    name: secret.name,
                    value: secret.value,
                })),
            };
        }

        function applyLinkedResourcesToEnvironment() {
            const { linkedEnvironment, linkedSecrets } =
                getLinkedEnvironmentData();

            // Apply default environment variables for all resources
            if (!args.config) args.config = {};
            if (!args.config.environment) args.config.environment = {};

            fs.appendFileSync(
                envFilePath,
                '\n' + '# --- SST-LARAVEL AUTO-INJECTED VARIABLES ---' + '\n',
            );

            addAppUrlIfMissing();
            envFileSetVariableIfMissing('LOG_CHANNEL', 'stderr');

            all(Object.entries(linkedEnvironment)).apply((entries) => {
                const envContent = entries
                    .map(([key, value]) => `${key}=${value}`)
                    .join('\n');

                if (envContent) {
                    fs.appendFileSync(envFilePath, '\n' + envContent);
                }
            });

            linkedSecrets.forEach((secret) => {
                all([secret.name, secret.value]).apply(([name, value]) => {
                    fs.appendFileSync(envFilePath, `\n${name}=${value}`);
                });
            });
        }

        /**
         * Return the links as an array of resources in the original SST format.
         */
        function getLinks(): any[] {
            return (args.link || []).map((link) => {
                if (link && typeof link === 'object' && 'resource' in link) {
                    return link.resource;
                }

                return link;
            });
        }

        function prepareEnvironmentFile() {
            const envFile = args.config?.environment?.file as
                | string
                | undefined;
            const secrets = args.config?.environment?.secrets;

            if (secrets) {
                return prepareRemoteEnvironmentFile(secrets);
            }

            // Handle traditional env file configuration
            if (!envFile) {
                return;
            }

            const src = path.resolve(absSitePath, envFile);

            if (fs.existsSync(src)) {
                fs.copyFileSync(src, envFilePath);
                fs.chmodSync(envFilePath, 0o755);
            } else {
                fs.writeFileSync(envFilePath, '');
            }

            if (args.config?.environment?.autoInject !== false) {
                applyLinkedResourcesToEnvironment();
            }
        }

        function prepareRemoteEnvironmentFile(secrets: RemoteEnvVault) {
            if (runtime.isDryRun() && !fs.existsSync(envFilePath)) {
                fs.writeFileSync(
                    envFilePath,
                    '# WARNING: RemoteEnvVault secrets are loaded during deployment. Preview uses a placeholder file.\n',
                );
                fs.chmodSync(envFilePath, 0o755);
            }

            const { linkedEnvironment, linkedSecrets } =
                getLinkedEnvironmentData();

            return new RemoteEnvFile(
                `${name}-RemoteEnv`,
                {
                    secretPath: secrets.path,
                    envFilePath,
                    fingerprint: output(secrets.path).apply((secretPath) =>
                        getSecretsFingerprint(secretPath),
                    ),
                    autoInject: args.config?.environment?.autoInject !== false,
                    appUrl: getAppUrl(),
                    linkedEnvironment,
                    linkedSecrets,
                },
                {
                    parent: this,
                },
            );
        }

        function addAppUrlIfMissing() {
            if (envFileHasVariable('APP_URL')) {
                return;
            }

            const appUrl = getAppUrl();

            if (typeof appUrl === 'string') {
                envFileSetVariable('APP_URL', appUrl);
            }
        }

        function getAppUrl(): PulumiInput<string | undefined> | undefined {
            if (!args.web?.domain) {
                return undefined;
            }

            if (typeof args.web.domain === 'string') {
                return `https://${args.web.domain}`;
            }

            if (
                typeof args.web.domain === 'object' &&
                'name' in args.web.domain
            ) {
                return output(
                    (args.web.domain as { name: Input<string> }).name,
                ).apply((domainName) =>
                    domainName ? `https://${domainName}` : undefined,
                );
            }

            return undefined;
        }

        function getReverbEnvironmentVariables() {
            if (!reverbConfig) {
                return {};
            }

            const publicHost = getDomainName(reverbConfig.domain);
            const serverVariables = buildReverbEnvironmentVariables({
                serverHost: reverbConfig.host,
                serverPort: reverbConfig.port,
            });

            if (!publicHost) {
                return serverVariables;
            }

            if (typeof publicHost === 'string') {
                return buildReverbEnvironmentVariables({
                    publicHost,
                    serverHost: reverbConfig.host,
                    serverPort: reverbConfig.port,
                });
            }

            return {
                ...serverVariables,
                REVERB_HOST: publicHost,
                REVERB_PORT: '443',
                REVERB_SCHEME: 'https',
            };
        }

        function shouldAutoInjectEnvironment(): boolean {
            return args.config?.environment?.autoInject !== false;
        }

        function getDomainName(
            domain?: LaravelDomain,
        ): PulumiInput<string | undefined> | undefined {
            if (!domain) {
                return undefined;
            }

            if (typeof domain === 'string') {
                return domain;
            }

            if (typeof domain === 'object' && 'name' in domain) {
                return output((domain as { name: Input<string> }).name).apply(
                    (domainName) => domainName || undefined,
                );
            }

            return undefined;
        }

        function normalizeReverbConfig(
            config?: boolean | LaravelReverbArgs,
        ): (LaravelReverbArgs & {
            command: string;
            host: string;
            port: number;
        }) | undefined {
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

        function prepareDeploymentScript() {
            const deployDir = path.resolve(pluginBuildPath, 'deploy');
            const dst = path.resolve(deployDir, '60-deploy.sh');

            fs.mkdirSync(deployDir, { recursive: true });

            const script = args.config?.deployment?.script as
                | string
                | undefined;
            if (script) {
                const src = path.resolve(absSitePath, script);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, dst);
                    fs.chmodSync(dst, 0o755);
                    return;
                }
            }

            fs.writeFileSync(dst, '#!/bin/sh\nexit 0\n');
            fs.chmodSync(dst, 0o755);
        }

        this.registerOutputs({ _hint: this.messages });
    }

    /**
     * The URL of the service.
     *
     * If `public.domain` is set, this is the URL with the custom domain.
     * Otherwise, it's the auto-generated load balancer URL.
     */
    public get url() {
        return this.services['web'].url;
    }

    /**
     * The URL of the Reverb service.
     *
     * If `reverb.domain` is set, this is the URL with the custom domain.
     * Otherwise, it's the auto-generated load balancer URL.
     */
    public get reverbUrl() {
        return this.services['reverb'].url;
    }

    /**
     * The messages from the service.
     *
     * This is useful for debugging and troubleshooting.
     */
    public get messages() {
        return this._messages;
    }
}

const __pulumiType = 'sst:aws:LaravelService';
// @ts-expect-error
LaravelService.__pulumiType = __pulumiType;
