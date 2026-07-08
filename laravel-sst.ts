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
    buildAccessLogsBucketPolicy,
    buildIngressRules,
    getStaticListenPorts,
    normalizeAccessLogsPrefix,
    resolveListenerSslPolicy,
} from './src/alb-hardening';
import { mergeServiceTransforms } from './src/transforms';
import * as pulumiAws from '@pulumi/aws';

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

/**
 * The subset of the `sst.aws.Service` transform map that consumers can extend.
 * `image` and `taskDefinition` are managed internally by the package.
 */
export type LaravelServiceTransform = Omit<
    NonNullable<ServiceArgs['transform']>,
    'image' | 'taskDefinition'
>;

export interface LaravelLoadBalancerAccessLogsArgs {
    /**
     * Name of an existing S3 bucket to deliver the access logs to. When
     * omitted, the package creates a dedicated bucket for you — encrypted
     * with SSE-S3 (ELB cannot deliver logs to KMS-encrypted buckets), with
     * public access blocked, and with the regional ELB log-delivery policy
     * already attached.
     *
     * When you bring your own bucket, you are responsible for its delivery
     * bucket policy — the package does not attach one, so it never conflicts
     * with a policy you already manage.
     *
     * @example
     * ```js
     * web: {
     *   loadBalancerAccessLogs: {
     *     bucket: myBucket.name,
     *   },
     * }
     * ```
     */
    bucket?: Input<string>;

    /**
     * S3 key prefix the logs are delivered under. Leading and trailing
     * slashes are stripped, since ELB rejects them.
     */
    prefix?: Input<string>;

    /**
     * Whether access logging is enabled on the load balancer. Set to `false`
     * to pre-provision the bucket and wiring without shipping logs yet.
     *
     * @default `true`
     */
    enabled?: Input<boolean>;

    /**
     * Days to keep access logs before they expire, applied as a lifecycle
     * rule. Only used when the package creates the bucket.
     */
    retentionDays?: number;
}

export interface LaravelIngressCidrsArgs {
    /**
     * IPv4 CIDR blocks allowed to reach the load balancer.
     */
    v4?: Input<string[]>;

    /**
     * IPv6 CIDR blocks allowed to reach the load balancer.
     */
    v6?: Input<string[]>;

    /**
     * Listener ports the ingress rules are generated for. Defaults to the
     * listen ports of the load balancer the package configures (`80`, plus
     * `443` when a domain is set). Set this explicitly when you provide a
     * custom `loadBalancer` whose ports cannot be determined statically.
     */
    ports?: Input<number[]>;
}

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
     * SSL security policy applied to the HTTPS/TLS listeners of the load
     * balancer, e.g. to enforce TLS 1.2+ instead of AWS's default policy
     * (which still permits TLS 1.0/1.1). The package only applies the policy
     * to TLS-bearing listeners — plain HTTP listeners (which reject SSL
     * policies) are left untouched, so you don't have to guard the listener
     * protocol yourself.
     *
     * @example
     * ```js
     * web: {
     *   sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
     * }
     * ```
     */
    sslPolicy?: Input<string>;

    /**
     * Restrict the load balancer security group ingress to a fixed set of
     * upstream CIDR blocks — for example the edge ranges of a WAF or CDN in
     * front of the load balancer, so it cannot be bypassed by hitting the
     * load balancer hostname directly. Replaces SST's default allow-all
     * ingress with one TCP rule per listener port for the given ranges.
     *
     * @example
     * ```js
     * web: {
     *   ingressCidrs: {
     *     v4: ['173.245.48.0/20', '103.21.244.0/22'],
     *     v6: ['2400:cb00::/32'],
     *   },
     * }
     * ```
     */
    ingressCidrs?: LaravelIngressCidrsArgs;

    /**
     * Ship the load balancer access logs to an S3 bucket. Set to `true` to
     * let the package create and wire up a dedicated bucket, or pass an
     * object to control the bucket, prefix, and retention.
     *
     * @example
     * ```js
     * web: {
     *   loadBalancerAccessLogs: true,
     * }
     * ```
     *
     * @example
     * ```js
     * web: {
     *   loadBalancerAccessLogs: {
     *     prefix: 'alb',
     *     retentionDays: 90,
     *   },
     * }
     * ```
     */
    loadBalancerAccessLogs?: boolean | LaravelLoadBalancerAccessLogsArgs;

    /**
     * Transform the underlying ECS Service resources.
     *
     * `image` and `taskDefinition` are managed internally and cannot be
     * overridden here — they carry the env-file dependency wiring and the
     * `initProcessEnabled: false` setting required by this package.
     *
     * Common ALB-hardening concerns have first-class options — see
     * {@link LaravelServiceArgs.sslPolicy}, {@link LaravelServiceArgs.ingressCidrs},
     * and {@link LaravelServiceArgs.loadBalancerAccessLogs} — and transforms
     * provided here compose with them: the package-generated transform runs
     * first, then yours.
     *
     * @example
     * ```js
     * web: {
     *   transform: {
     *     loadBalancer: (lbArgs) => {
     *       lbArgs.idleTimeout = 120;
     *     },
     *   },
     * }
     * ```
     */
    transform?: LaravelServiceTransform;
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

export interface LaravelWebArgs extends LaravelServiceArgs {
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

export interface LaravelWorkerConfig extends LaravelServiceArgs {
    name?: Input<string>;
    /**
     * Running horizon?
     */
    horizon?: Input<boolean>;

    /**
     * Running scheduler?
     */
    scheduler?: Input<boolean>;

    /**
     * Multiple tasks can be run in the worker.
     */
    tasks?: Input<{
        [key: string]: Input<{
            command: Input<string>;
            dependencies?: Input<string[]>;
        }>;
    }>;
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

        const prepareAccessLogsBucket = (
            serviceName: string,
            config: LaravelLoadBalancerAccessLogsArgs,
        ): {
            bucket: Input<string>;
            dependsOn?: pulumiAws.s3.BucketPolicy[];
        } => {
            if (config.bucket) {
                return { bucket: config.bucket };
            }

            const bucket = new pulumiAws.s3.Bucket(
                `${serviceName}-AccessLogs`,
                {},
                { parent: this },
            );

            new pulumiAws.s3.BucketServerSideEncryptionConfiguration(
                `${serviceName}-AccessLogsEncryption`,
                {
                    bucket: bucket.id,
                    rules: [
                        {
                            applyServerSideEncryptionByDefault: {
                                sseAlgorithm: 'AES256',
                            },
                        },
                    ],
                },
                { parent: this },
            );

            new pulumiAws.s3.BucketPublicAccessBlock(
                `${serviceName}-AccessLogsPublicAccessBlock`,
                {
                    bucket: bucket.id,
                    blockPublicAcls: true,
                    blockPublicPolicy: true,
                    ignorePublicAcls: true,
                    restrictPublicBuckets: true,
                },
                { parent: this },
            );

            const bucketPolicy = new pulumiAws.s3.BucketPolicy(
                `${serviceName}-AccessLogsPolicy`,
                {
                    bucket: bucket.id,
                    policy: all([
                        bucket.arn,
                        pulumiAws.getCallerIdentityOutput().accountId,
                        pulumiAws.getRegionOutput().region,
                        config.prefix,
                    ]).apply(([bucketArn, accountId, region, prefix]) =>
                        JSON.stringify(
                            buildAccessLogsBucketPolicy({
                                bucketArn,
                                accountId,
                                region,
                                prefix,
                            }),
                        ),
                    ),
                },
                { parent: this },
            );

            if (config.retentionDays) {
                new pulumiAws.s3.BucketLifecycleConfiguration(
                    `${serviceName}-AccessLogsLifecycle`,
                    {
                        bucket: bucket.id,
                        rules: [
                            {
                                id: 'expire-access-logs',
                                status: 'Enabled',
                                filter: {},
                                expiration: { days: config.retentionDays },
                            },
                        ],
                    },
                    { parent: this },
                );
            }

            return { bucket: bucket.bucket, dependsOn: [bucketPolicy] };
        };

        /**
         * Builds the package-generated transform entries for the first-class
         * ALB-hardening options (`sslPolicy`, `ingressCidrs`,
         * `loadBalancerAccessLogs`). Returns an empty map when the service has
         * no load balancer, so no orphan resources are created.
         */
        const buildAlbHardeningTransform = (
            serviceConfig: LaravelServiceArgs,
            serviceName: string,
            loadBalancer: unknown,
        ): LaravelServiceTransform => {
            const hardening: LaravelServiceTransform = {};

            if (!loadBalancer) {
                return hardening;
            }

            if (serviceConfig.sslPolicy) {
                const sslPolicy = serviceConfig.sslPolicy;

                hardening.listener = (listenerArgs) => {
                    listenerArgs.sslPolicy = all([
                        listenerArgs.protocol,
                        sslPolicy,
                    ]).apply(([protocol, policy]) =>
                        resolveListenerSslPolicy(protocol, policy),
                    ) as Output<string>;
                };
            }

            if (serviceConfig.ingressCidrs) {
                const cidrs = serviceConfig.ingressCidrs;
                const fallbackPorts = getStaticListenPorts(loadBalancer) ?? [
                    80, 443,
                ];

                hardening.loadBalancerSecurityGroup = (sgArgs) => {
                    sgArgs.ingress = all([
                        cidrs.v4,
                        cidrs.v6,
                        cidrs.ports,
                    ]).apply(([v4, v6, ports]) =>
                        buildIngressRules(ports ?? fallbackPorts, { v4, v6 }),
                    );
                };
            }

            const accessLogsConfig =
                serviceConfig.loadBalancerAccessLogs === true
                    ? {}
                    : serviceConfig.loadBalancerAccessLogs || undefined;

            if (accessLogsConfig) {
                const { bucket, dependsOn } = prepareAccessLogsBucket(
                    serviceName,
                    accessLogsConfig,
                );

                hardening.loadBalancer = (lbArgs, opts) => {
                    lbArgs.accessLogs = {
                        bucket,
                        prefix: output(accessLogsConfig.prefix).apply(
                            (prefix) => normalizeAccessLogsPrefix(prefix),
                        ) as Output<string>,
                        enabled: accessLogsConfig.enabled ?? true,
                    };

                    if (dependsOn) {
                        opts.dependsOn = dependsOn;
                    }
                };
            }

            return hardening;
        };

        const cluster = new sst.aws.Cluster(`${name}-Cluster`, {
            vpc: normalizeClusterVpc(args.vpc),
        });

        const addWebService = () => {
            const envVariables = {
                ...getEnvironmentVariables(),
                ...buildWebServerEnvironment({
                    accessLogs: args.web?.accessLogs,
                }),
            };

            const loadBalancer =
                args.web && args.web.loadBalancer
                    ? args.web.loadBalancer
                    : {
                          domain: args.web?.domain,
                          ports: buildDefaultPublicPorts({
                              hasDomain: Boolean(args.web?.domain),
                              httpsRedirect: args.web?.httpsRedirect ?? true,
                          }),
                          ...(args.web?.healthCheck
                              ? {
                                    health: {
                                        '8080/http': args.web.healthCheck,
                                    },
                                }
                              : {}),
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
                    image: getImage(ImageType.Web),
                    environment: envVariables,
                    scaling: args.web?.scaling,

                    loadBalancer,

                    dev: {
                        command: `php ${sitePath}/artisan serve`,
                    },

                    transform: {
                        ...mergeServiceTransforms(
                            buildAlbHardeningTransform(
                                args.web ?? {},
                                `${name}-Web`,
                                loadBalancer,
                            ),
                            args.web?.transform,
                        ),
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

        function createWorkerTasks(
            workerConfig: LaravelWorkerConfig,
            workerBuildPath: string,
        ) {
            const s6RcDPath = path.resolve(
                workerBuildPath,
                'etc/s6-overlay/s6-rc.d',
            );
            const s6UserContentsPath = path.resolve(
                s6RcDPath,
                'user/contents.d',
            );

            fs.mkdirSync(s6UserContentsPath, { recursive: true });

            const tasks: Record<
                string,
                { command: string; dependencies?: string[] }
            > = {
                ...((workerConfig.tasks as any) ?? {}),
            };

            if (workerConfig.horizon) {
                tasks['laravel-horizon'] = {
                    command: 'php artisan horizon',
                };
            }

            if (workerConfig.scheduler) {
                tasks['laravel-scheduler'] = {
                    command: 'php artisan schedule:work',
                };
            }

            Object.entries(tasks).forEach(([taskName, config]) => {
                const tasksDir = path.resolve(s6RcDPath, `${taskName}`);
                fs.mkdirSync(tasksDir, { recursive: true });

                const scriptSrcPath = path.join(tasksDir, 'script');

                fs.writeFileSync(
                    scriptSrcPath,
                    `#!/command/with-contenv bash\ncd /var/www/html\n${config.command}`,
                    { mode: 0o777 },
                );
                fs.writeFileSync(
                    path.join(tasksDir, 'run'),
                    `#!/command/execlineb -P\n/etc/s6-overlay/s6-rc.d/${taskName}/script`,
                    { mode: 0o777 },
                );
                fs.writeFileSync(path.join(tasksDir, 'type'), 'longrun');
                fs.writeFileSync(
                    path.join(tasksDir, 'dependencies'),
                    (config.dependencies || []).join('\n'),
                );
                fs.writeFileSync(path.join(s6UserContentsPath, taskName), '');
            });
        }

        const createWorkerService = (
            workerConfig: LaravelWorkerConfig,
            serviceName: string,
            workerBuildPath: string,
            serviceKey = serviceName,
            devCommand = `php ${sitePath}/artisan horizon`,
        ) => {
            createWorkerTasks(workerConfig, workerBuildPath);

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
                        ...mergeServiceTransforms(
                            buildAlbHardeningTransform(
                                workerConfig,
                                serviceName,
                                workerConfig.loadBalancer,
                            ),
                            workerConfig.transform,
                        ),
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
