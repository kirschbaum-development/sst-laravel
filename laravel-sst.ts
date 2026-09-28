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
import {
  assertLoadBalancerArgs,
  buildAccessLogsBucketPolicy,
  buildIngressRules,
  DEFAULT_INGRESS_CIDRS,
  FALLBACK_LISTENER_PORTS,
  findLoadBalancerKeys,
  getLoadBalancerKind,
  getStaticListenerPorts,
  normalizeAccessLogsPrefix,
  resolveAccessLogsRetentionDays,
  resolveListenerSslPolicy,
} from './src/load-balancer-hardening';
import { buildWebServerEnvironment } from './src/web-server';
import {
  buildServiceArgs,
  composeTransform,
  composeTransforms,
  findDeprecatedTopLevelKeys,
  LaravelAdvancedArgs,
  resolveAdvancedArgs,
} from './src/service-args';
import { buildSizeDefaults, ServiceSize } from './src/size';
import {
    assertSafeWorkerName,
    buildBackgroundTasks,
    writeS6TaskFiles,
} from './src/background-tasks';

// Re-export RemoteEnvVault for external use
export { RemoteEnvVault, RemoteEnvVaultArgs };
export type { PlanetScaleProperties } from './src/planetscale-env.js';

/** The `transform.service` hook of `sst.aws.Service` (the ECS service). */
type ServiceResourceTransform = NonNullable<ServiceArgs['transform']>['service'];

/** The transforms the package generates for the load balancer options. */
type LoadBalancerHardeningTransforms = {
    listener?: (args: aws.lb.ListenerArgs) => void;
    loadBalancer?: (
        args: aws.lb.LoadBalancerArgs,
        opts: $util.CustomResourceOptions,
    ) => void;
    loadBalancerSecurityGroup?: (args: aws.ec2.SecurityGroupArgs) => void;
};

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

export interface LaravelLoadBalancerAccessLogsArgs {
    /**
     * An existing S3 bucket to deliver the access logs to: an
     * `sst.aws.Bucket` or a bucket name. When omitted, the package creates a
     * dedicated bucket with public access blocked and the Elastic Load
     * Balancing log-delivery policy attached. It uses the S3 default
     * encryption (SSE-S3), since ELB cannot deliver logs to a bucket
     * encrypted with a KMS key.
     *
     * When you bring your own bucket, you own its bucket policy. The package
     * does not attach one, because a bucket can only have a single policy.
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     accessLogs: {
     *       bucket: myBucket,
     *     },
     *   },
     * }
     * ```
     */
    bucket?: Input<string> | { name: Input<string> };

    /**
     * S3 key prefix the logs are delivered under. Leading and trailing
     * slashes are stripped, since ELB rejects them. The prefix must not
     * include the reserved `AWSLogs` path segment.
     */
    prefix?: Input<string>;

    /**
     * Whether the load balancer ships access logs. Set to `false` to stop
     * shipping logs while keeping the bucket and the logs already in it.
     *
     * @default `true`
     */
    enabled?: Input<boolean>;

    /**
     * Days to keep access logs before they expire. Set to `false` to keep
     * them forever. Only used when the package creates the bucket.
     *
     * @default `90`
     */
    retentionDays?: number | false;
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
     * ports the load balancer listens on (`80`, plus `443` when a domain is
     * set). Only needed when `advanced.loadBalancer` is a value the package
     * cannot read before the deploy, in which case `80` and `443` are used.
     */
    ports?: Input<number[]>;
}

/**
 * Options for the load balancer SST creates in front of a service.
 *
 * The load balancer is hardened by default: its HTTPS listeners only accept
 * TLS 1.2 and 1.3, its security group only opens the ports it listens on,
 * and it drops HTTP headers with an invalid name.
 */
export interface LaravelLoadBalancerArgs {
    /**
     * SSL security policy for the HTTPS/TLS listeners of the load balancer.
     * The default is the policy AWS recommends, which accepts TLS 1.2 and
     * 1.3 only. Plain HTTP listeners reject an SSL policy, so the package
     * leaves them untouched.
     *
     * @default `"ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"`
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
     *   },
     * }
     * ```
     */
    sslPolicy?: Input<string>;

    /**
     * Only accept traffic to the load balancer from these CIDR blocks, for
     * example the edge ranges of the CDN or WAF in front of it, so nobody can
     * go around it by calling the load balancer address directly.
     *
     * By default the load balancer accepts traffic from everywhere, but only
     * on the ports it listens on (SST opens every port and protocol).
     *
     * Pass a list (IPv4 and IPv6 blocks are told apart for you), or an
     * object with `v4`, `v6`, and `ports`.
     *
     * @default `["0.0.0.0/0"]`
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     ingressCidrs: ['173.245.48.0/20', '103.21.244.0/22', '2400:cb00::/32'],
     *   },
     * }
     * ```
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     ingressCidrs: {
     *       v4: ['173.245.48.0/20', '103.21.244.0/22'],
     *       v6: ['2400:cb00::/32'],
     *     },
     *   },
     * }
     * ```
     */
    ingressCidrs?: Input<string[]> | LaravelIngressCidrsArgs;

    /**
     * Ship the load balancer access logs to an S3 bucket. Set to `true` to
     * let the package create the bucket, or pass an object to choose the
     * bucket, prefix, and retention.
     *
     * Not the same as `web.accessLogs`, which is about the nginx logs the
     * container sends to CloudWatch.
     *
     * Off by default, since it creates a bucket and adds storage cost to
     * every stage.
     *
     * @default `false`
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     accessLogs: true,
     *   },
     * }
     * ```
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     accessLogs: {
     *       prefix: 'alb',
     *       retentionDays: 365,
     *     },
     *   },
     * }
     * ```
     */
    accessLogs?: boolean | LaravelLoadBalancerAccessLogsArgs;
}

export interface LaravelServiceArgs {
    /**
     * Simple container size. Maps to a valid Fargate cpu/memory pair:
     * `small` (0.5 vCPU / 1 GB), `medium` (1 vCPU / 2 GB),
     * `large` (2 vCPU / 4 GB). Setting `cpu` or `memory` directly wins
     * over `size`.
     */
    size?: ServiceSize;
    cpu?: ServiceArgs['cpu'];
    memory?: ServiceArgs['memory'];
    scaling?: ServiceArgs['scaling'];
    permissions?: ServiceArgs['permissions'];

    /**
     * Options for the load balancer in front of the service: `sslPolicy`,
     * `ingressCidrs`, and `accessLogs`. It needs a load balancer, so it
     * applies to `web`, `reverb`, and workers with `advanced.loadBalancer`.
     *
     * The load balancer is hardened by default, so you only need this to
     * go further (an IP allowlist, access logs) or to pick another policy.
     *
     * The SST load balancer config (`rules`, `domain`, `health`, ...) does
     * not go here. Set `advanced.loadBalancer` for that.
     *
     * @example
     * ```js
     * web: {
     *   loadBalancer: {
     *     ingressCidrs: ['173.245.48.0/20', '2400:cb00::/32'],
     *     accessLogs: true,
     *   },
     * }
     * ```
     */
    loadBalancer?: LaravelLoadBalancerArgs;

    /**
     * Escape hatch for SST experts. Values here are passed straight to the
     * underlying `sst.aws.Service`. Prefer the simple options above — use
     * `advanced` only when you know what the SST Service does with the value.
     *
     * @example
     * ```js
     * web: {
     *   advanced: {
     *     architecture: 'arm64',
     *   },
     * }
     * ```
     */
    advanced?: LaravelAdvancedArgs;

    /** @deprecated Set `advanced.architecture` instead. */
    architecture?: ServiceArgs['architecture'];
    /** @deprecated Set `advanced.storage` instead. */
    storage?: ServiceArgs['storage'];
    /** @deprecated Set `advanced.logging` instead. */
    logging?: ServiceArgs['logging'];
    /**
     * @deprecated Set `advanced.health` instead. Note this is the
     * container-level check — different from `web.healthCheck`, which is
     * the load balancer URL check.
     */
    health?: ServiceArgs['health'];
    /** @deprecated Set `advanced.executionRole` instead. */
    executionRole?: ServiceArgs['executionRole'];

    /**
     * Transform the underlying ECS Service resources.
     *
     * `image` and `taskDefinition` are managed internally and cannot be
     * overridden here — they carry the env-file dependency wiring and the
     * `initProcessEnabled: false` setting required by this package.
     *
     * For the load balancer, reach for the `loadBalancer` options first.
     * A transform for the same resource runs after them, so it still has
     * the last word.
     *
     * Prefer `advanced.transform`. This top-level alias still works for
     * existing projects.
     *
     * @example
     * ```js
     * web: {
     *   advanced: {
     *     transform: {
     *       loadBalancer: (lbArgs) => {
     *         lbArgs.idleTimeout = 120;
     *       },
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
 * A resource linked into the Laravel containers, with optional extra
 * environment variables.
 */
export interface LaravelLinkObject {
    resource: any;
    /**
     * Preferred. Receives the linked resource and returns extra environment
     * variables. Merged over the auto-injected defaults for that resource.
     *
     * @example
     * ```js
     * link: [
     *   {
     *     resource: database,
     *     envFrom: (db) => ({
     *       CUSTOM_DB_HOST: db.host,
     *     }),
     *   },
     * ],
     * ```
     */
    envFrom?: EnvCallback;
    /**
     * @deprecated Use `envFrom` instead. Kept working for existing projects.
     */
    environment?: EnvCallback;
}

export type LaravelLink = any | LaravelLinkObject;

/**
 * Shorthand for the load balancer health check applied to the default forward
 * port. Mirrors the inner shape of SST's `loadBalancer.health` entry, minus the
 * per-port keying which the package fills in for you.
 *
 * Not used when `advanced.loadBalancer` is provided — in that case configure
 * its `health` directly.
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
     * Ignored when `advanced.loadBalancer` is set — configure its `health`
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
     * redirect to) or when `advanced.loadBalancer` is provided (configure
     * its `rules` yourself in that case).
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
    link?: LaravelLink[];

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
        php?: Input<number>;

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

        // Captured for `function` declarations below, where `this` is unbound.
        const componentMessages = this._messages;

        args.config = args.config ?? {};
        const sitePath = args.path ?? '.';
        const absSitePath = path.resolve(sitePath.toString());
        const nodeModulePath = getPackagePath();
        const reverbConfig = normalizeReverbConfig(args.reverb);

        // Check the load balancer options first, so that a mistake in them
        // fails the deploy before anything is created.
        const services: [string, LaravelServiceArgs | undefined][] = [
            ['web', args.web],
            ['reverb', reverbConfig],
            ...(args.workers ?? []).map(
                (worker, index): [string, LaravelServiceArgs] => [
                    `workers[${worker.name || `worker-${index + 1}`}]`,
                    worker,
                ],
            ),
        ];

        for (const [label, config] of services) {
            assertLoadBalancerArgs(
                label,
                config?.loadBalancer,
                resolveAdvancedArgs(config).loadBalancer,
            );
        }

        /**
         * Merges a `web`, `workers[]`, or `reverb` block into the args for the
         * underlying `sst.aws.Service`. Simple options (`size`, `cpu`,
         * `memory`, `permissions`) stay first-class; everything else lives
         * under `advanced` with the old top-level keys kept as deprecated
         * aliases (the `advanced` value wins when both are set).
         */
        const resolveBlockServiceArgs = (
          label: string,
          config?: LaravelServiceArgs & LaravelBackgroundTasksArgs,
        ): Record<string, unknown> => {
          const advanced = config?.advanced ?? {};

          for (const key of findDeprecatedTopLevelKeys(config)) {
            if (
              (advanced as Record<string, unknown>)[key] === undefined &&
              (config as Record<string, unknown>)[key] !== undefined
            ) {
              console.warn(
                `[sst-laravel] ${label}.${key} is deprecated. Use ${label}.advanced.${key} instead.`,
              );
            }
          }

          const { loadBalancer, transform, ...advancedPassthrough } =
            resolveAdvancedArgs(config) as Record<string, unknown> & {
              loadBalancer?: unknown;
              transform?: Record<string, unknown>;
            };

          return {
            ...buildSizeDefaults(config),
            ...buildServiceArgs(config),
            ...advancedPassthrough,
            ...(loadBalancer !== undefined ? { loadBalancer } : {}),
            ...(transform !== undefined ? { transform } : {}),
          };
        };

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

        /**
         * Creates the bucket the load balancer delivers its access logs to.
         * It keeps the S3 default encryption (SSE-S3): ELB cannot deliver
         * logs to a bucket encrypted with a KMS key.
         *
         * Like SST's own buckets, it is emptied and removed with the stage,
         * unless the app sets `removal: "retain"`.
         */
        const createAccessLogsBucket = (
            serviceName: string,
            config: LaravelLoadBalancerAccessLogsArgs,
        ) => {
            const bucket = new aws.s3.Bucket(
                `${serviceName}-AccessLogs`,
                { forceDestroy: true },
                { parent: this },
            );

            const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
                `${serviceName}-AccessLogsPublicAccessBlock`,
                {
                    bucket: bucket.bucket,
                    blockPublicAcls: true,
                    blockPublicPolicy: true,
                    ignorePublicAcls: true,
                    restrictPublicBuckets: true,
                },
                { parent: this },
            );

            const policy = new aws.s3.BucketPolicy(
                `${serviceName}-AccessLogsPolicy`,
                {
                    bucket: bucket.bucket,
                    policy: all([
                        bucket.arn,
                        aws.getCallerIdentityOutput({}, { parent: this })
                            .accountId,
                        aws.getRegionOutput({}, { parent: this }).region,
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
                { parent: this, dependsOn: publicAccessBlock },
            );

            const retentionDays = resolveAccessLogsRetentionDays(
                config.retentionDays,
            );

            if (retentionDays) {
                new aws.s3.BucketLifecycleConfiguration(
                    `${serviceName}-AccessLogsLifecycle`,
                    {
                        bucket: bucket.bucket,
                        rules: [
                            {
                                id: 'expire-access-logs',
                                status: 'Enabled',
                                filter: {},
                                expiration: { days: retentionDays },
                            },
                        ],
                    },
                    { parent: this },
                );
            }

            return { bucket: bucket.bucket, policy };
        };

        /**
         * Builds the transforms that harden the load balancer SST creates
         * for the service, from the secure defaults and the `loadBalancer`
         * options of the block (`sslPolicy`, `ingressCidrs`, `accessLogs`).
         */
        const buildLoadBalancerHardening = (
            label: string,
            serviceName: string,
            config: LaravelLoadBalancerArgs = {},
            loadBalancer: unknown,
        ): LoadBalancerHardeningTransforms => {
            const kind = getLoadBalancerKind(loadBalancer);

            // Nothing to harden: the service has no load balancer, or it
            // uses a shared one, which belongs to its own component.
            if (kind !== 'dedicated') {
                const keys = findLoadBalancerKeys(config);

                if (keys.length > 0 && kind === 'none') {
                    console.warn(
                        `[sst-laravel] ${keys
                            .map((key) => `${label}.loadBalancer.${key}`)
                            .join(', ')} ignored: ${label} has no load balancer.`,
                    );
                }

                return {};
            }

            const hardening: LoadBalancerHardeningTransforms = {
                listener: (listenerArgs) => {
                    listenerArgs.sslPolicy = all([
                        listenerArgs.protocol,
                        config.sslPolicy,
                    ]).apply(([protocol, policy]) =>
                        resolveListenerSslPolicy(protocol, policy),
                    ) as Output<string>;
                },
            };

            const listenerPorts = getStaticListenerPorts(loadBalancer);
            const ingressCidrs = config.ingressCidrs;

            if (ingressCidrs) {
                const ingress =
                    Array.isArray(ingressCidrs) ||
                    ingressCidrs instanceof Promise ||
                    Output.isInstance(ingressCidrs)
                        ? output(ingressCidrs as Input<string[]>).apply(
                              (cidrs) =>
                                  buildIngressRules(
                                      listenerPorts ?? FALLBACK_LISTENER_PORTS,
                                      cidrs,
                                  ),
                          )
                        : all([
                              (ingressCidrs as LaravelIngressCidrsArgs).v4,
                              (ingressCidrs as LaravelIngressCidrsArgs).v6,
                              (ingressCidrs as LaravelIngressCidrsArgs).ports,
                          ]).apply(([v4, v6, ports]) =>
                              buildIngressRules(
                                  ports?.map((port) => ({
                                      port,
                                      protocol: 'tcp' as const,
                                  })) ??
                                      listenerPorts ??
                                      FALLBACK_LISTENER_PORTS,
                                  { v4, v6 },
                              ),
                          );

                hardening.loadBalancerSecurityGroup = (sgArgs) => {
                    sgArgs.ingress = ingress;
                };
            } else if (listenerPorts) {
                // Without the ports, keep the rule SST creates. Guessing
                // them could lock everyone out of a custom load balancer.
                hardening.loadBalancerSecurityGroup = (sgArgs) => {
                    sgArgs.ingress = buildIngressRules(
                        listenerPorts,
                        DEFAULT_INGRESS_CIDRS,
                    );
                };
            }

            const accessLogs =
                config.accessLogs === true
                    ? {}
                    : config.accessLogs || undefined;
            const ownBucket = accessLogs?.bucket;
            const createdBucket =
                accessLogs && !ownBucket
                    ? createAccessLogsBucket(serviceName, accessLogs)
                    : undefined;

            hardening.loadBalancer = (lbArgs, opts) => {
                // Only application load balancers read HTTP headers.
                lbArgs.dropInvalidHeaderFields = output(
                    lbArgs.loadBalancerType,
                ).apply((type) =>
                    type === 'network' ? undefined : true,
                ) as Output<boolean>;

                if (!accessLogs) {
                    return;
                }

                lbArgs.accessLogs = {
                    bucket:
                        createdBucket?.bucket ??
                        (typeof ownBucket === 'object' &&
                        !(ownBucket instanceof Promise) &&
                        !Output.isInstance(ownBucket)
                            ? (ownBucket as { name: Input<string> }).name
                            : (ownBucket as Input<string>)),
                    prefix: output(accessLogs.prefix).apply((prefix) =>
                        normalizeAccessLogsPrefix(prefix),
                    ) as Output<string>,
                    enabled: accessLogs.enabled ?? true,
                };

                // AWS checks it can write to the bucket when access logs
                // are turned on, so the bucket policy has to exist first.
                if (createdBucket) {
                    opts.dependsOn = [
                        ...([opts.dependsOn ?? []].flat() as $util.Resource[]),
                        createdBucket.policy,
                    ];
                }
            };

            return hardening;
        };

        const clusterNetwork = normalizeClusterVpc(args.vpc);
        const cluster = new sst.aws.Cluster(`${name}-Cluster`, {
            vpc: clusterNetwork.vpc,
        });

        /**
         * SST only gives containers a public IP when the cluster gets the
         * `sst.aws.Vpc` itself. We pass a plain object so we can choose the
         * subnets, so set the public IP on the ECS service to match. The
         * user's `advanced.transform.service` still runs after this.
         */
        const withContainerNetwork = (
            userTransform: unknown,
        ): ServiceResourceTransform => {
            const assignPublicIp = clusterNetwork.assignPublicIp;

            if (!assignPublicIp) {
                return userTransform as ServiceResourceTransform;
            }

            return composeTransform<{
                networkConfiguration?: PulumiInput<object>;
            }>((serviceArgs) => {
                serviceArgs.networkConfiguration = all([
                    serviceArgs.networkConfiguration,
                    assignPublicIp,
                ]).apply(([networkConfiguration, publicIp]) => ({
                    ...networkConfiguration,
                    assignPublicIp: publicIp,
                }));
            }, userTransform) as ServiceResourceTransform;
        };

        const addWebService = () => {
            const webBuildPath = path.resolve(pluginBuildPath, 'web');
            writeS6TaskFiles(buildBackgroundTasks(args.web ?? {}), webBuildPath);

            const envVariables = {
                ...getEnvironmentVariables(),
                ...buildWebServerEnvironment({
                    accessLogs: args.web?.accessLogs,
                }),
            };

            const webResolved = resolveBlockServiceArgs(
                'web',
                args.web,
            ) as {
                loadBalancer?: ServiceArgs['loadBalancer'];
                transform?: Record<string, unknown>;
                [key: string]: unknown;
            };
            const webLoadBalancer: ServiceArgs['loadBalancer'] =
                webResolved.loadBalancer
                    ? webResolved.loadBalancer
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
            const webTransform = composeTransforms(
                buildLoadBalancerHardening(
                    'web',
                    `${name}-Web`,
                    args.web?.loadBalancer,
                    webLoadBalancer,
                ),
                webResolved.transform,
            );

            this.services['web'] = new sst.aws.Service(
                `${name}-Web`,
                {
                    cluster,
                    link: getLinks(),
                    permissions: args.permissions,
                    ...webResolved,

                    /**
                     * Image passed or use our default provided image.
                     */
                    image: getImage(ImageType.Web, {
                        CUSTOM_CONF_PATH: webBuildPath.replace(absSitePath, ''),
                    }),
                    environment: envVariables,
                    scaling: args.web?.scaling,

                    loadBalancer: webLoadBalancer,

                    dev: {
                        command: `php ${sitePath}/artisan serve`,
                    },

                    transform: {
                        ...webTransform,
                        service: withContainerNetwork(webTransform.service),
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

            const workerLabel =
                serviceKey === 'reverb'
                    ? 'reverb'
                    : `workers[${(workerConfig.name as string) ?? serviceKey}]`;
            const workerResolved = resolveBlockServiceArgs(
                workerLabel,
                workerConfig,
            ) as {
                loadBalancer?: ServiceArgs['loadBalancer'];
                transform?: Record<string, unknown>;
                [key: string]: unknown;
            };
            const { loadBalancer: workerLoadBalancer } = workerResolved;
            const workerTransform = composeTransforms(
                buildLoadBalancerHardening(
                    workerLabel,
                    serviceName,
                    workerConfig.loadBalancer,
                    workerLoadBalancer,
                ),
                workerResolved.transform,
            );

            this.services[serviceKey] = new sst.aws.Service(
                serviceName,
                {
                    cluster,
                    link: getLinks(),
                    permissions: args.permissions,
                    ...workerResolved,

                    image: getImage(ImageType.Worker, imgBuildArgs),
                    scaling: workerConfig.scaling,
                    environment: getEnvironmentVariables(),
                    loadBalancer: workerLoadBalancer,

                    dev: {
                        command: devCommand,
                    },

                    transform: {
                        ...workerTransform,
                        service: withContainerNetwork(workerTransform.service),
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
            const reverbAdvanced = resolveAdvancedArgs(reverbConfig) as {
                loadBalancer?: ServiceArgs['loadBalancer'];
            };
            const reverbWorkerConfig: LaravelWorkerConfig = {
                ...reverbConfig,
                name: 'reverb',
                advanced: {
                    ...reverbConfig.advanced,
                    loadBalancer: reverbAdvanced.loadBalancer ?? {
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

        /**
         * Picks the subnets the containers run in when `vpc` is an
         * `sst.aws.Vpc`.
         *
         * With NAT, containers stay in the private subnets and reach the
         * internet through it. Without NAT, private subnets have no route
         * out, so containers could not even pull their image from ECR. They
         * run in the public subnets with a public IP instead, which is what
         * SST does by default. The VPC security group still only accepts
         * inbound traffic from inside the VPC (the load balancer).
         */
        function normalizeClusterVpc(vpc: LaravelArgs['vpc']): {
            vpc: LaravelArgs['vpc'];
            assignPublicIp?: Output<boolean>;
        } {
            if (
                !vpc ||
                typeof vpc !== 'object' ||
                !('publicSubnets' in vpc) ||
                !('nodes' in vpc)
            ) {
                return { vpc };
            }

            const cloudmapNamespace = vpc.nodes?.cloudmapNamespace;

            if (!cloudmapNamespace) {
                return { vpc };
            }

            const hasNat = all([
                vpc.nodes.natGateways,
                vpc.nodes.natInstances,
            ]).apply(
                ([natGateways, natInstances]) =>
                    natGateways.length > 0 || natInstances.length > 0,
            );

            return {
                vpc: {
                    id: vpc.id,
                    securityGroups: vpc.securityGroups,
                    containerSubnets: hasNat.apply((nat) =>
                        nat ? vpc.privateSubnets : vpc.publicSubnets,
                    ),
                    loadBalancerSubnets: vpc.publicSubnets,
                    cloudmapNamespaceId: cloudmapNamespace.id,
                    cloudmapNamespaceName: cloudmapNamespace.name,
                },
                assignPublicIp: hasNat.apply((nat) => !nat),
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
                componentMessages.push(
                    `Updated ${dockerIgnore} to exclude .sst but keep .sst/laravel for the Docker build.`,
                );
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
                    const linkObject = link as {
                        resource: any;
                        envFrom?: EnvCallback;
                        environment?: EnvCallback;
                        envCallback?: EnvCallback;
                    };

                    if (linkObject.envFrom && linkObject.environment) {
                        throw new Error(
                            'A linked resource cannot set both `envFrom` and `environment`. Use `envFrom`.',
                        );
                    }

                    const callback =
                        linkObject.envFrom ||
                        linkObject.environment ||
                        linkObject.envCallback;
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
     * The URL of the web service.
     *
     * If `web.domain` is set, this is the URL with the custom domain.
     * Otherwise, it's the auto-generated load balancer URL.
     * `undefined` when no `web` service is configured.
     */
    public get url() {
        return this.services['web']?.url;
    }

    /**
     * The URL of the Reverb service.
     *
     * If `reverb.domain` is set, this is the URL with the custom domain.
     * Otherwise, it's the auto-generated load balancer URL.
     * `undefined` when no `reverb` service is configured.
     */
    public get reverbUrl() {
        return this.services['reverb']?.url;
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
