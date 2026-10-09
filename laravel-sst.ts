import * as path from 'path';
import * as fs from 'fs';
import { ComponentResourceOptions, Resource, rootStackResource } from '@pulumi/pulumi';
import { ClusterArgs, Component, Dns, FunctionArgs, Input, ServiceArgs } from './src/sst-platform';
import { EnvCallback } from './src/laravel-env';
import { RemoteEnvVault, RemoteEnvVaultArgs } from './src/laravel-env-manager';
import { getPackagePath } from './src/config';
import { ensureDockerIgnore } from './src/docker-ignore';
import { writeS6TaskFiles } from './src/background-tasks';
import { stageDeploymentScript, stageWorkerConf } from './src/build-files';
import { prepareEnvironmentFile } from './src/env-file';
import { buildContainerEnvironment, buildReverbEnvironment, getAppUrl } from './src/environment';
import { buildImage, managedImageTransform } from './src/image';
import { linkResources } from './src/links';
import { buildLoadBalancerHardening } from './src/load-balancer-transforms';
import { ClusterNetwork, resolveClusterNetwork, withContainerNetwork } from './src/network';
import { composeTransforms, disableInitProcess, LaravelAdvancedArgs } from './src/service-args';
import { planServices, resolveReverbArgs, ServicePlan } from './src/services';
import { ServiceSize } from './src/size';
import type { DeploymentManifest } from './src/deployment';

// Re-export RemoteEnvVault for external use
export { RemoteEnvVault, RemoteEnvVaultArgs };
export type { PlanetScaleProperties } from './src/planetscale-env.js';
export type LaravelDeployment = DeploymentManifest<Input<string>>;

/** The `transform.service` hook of `sst.aws.Service` (the ECS service). */
type ServiceResourceTransform = NonNullable<ServiceArgs['transform']>['service'];

/** The resources a `LaravelService` creates. */
export interface LaravelServiceNodes {
    /** The ECS cluster the services run in. */
    cluster: sst.aws.Cluster;
    /** The web service, when `web` is set. */
    web?: sst.aws.Service;
    /** The Reverb service, when `reverb` is set. */
    reverb?: sst.aws.Service;
    /** The worker services, by worker name. */
    workers: Record<string, sst.aws.Service>;
}

/**
 * Created without a parent before 0.7.0: moves them under the component
 * instead of replacing them.
 */
const CREATED_WITHOUT_PARENT = [{ parent: rootStackResource }];

/** What every service of the component shares. */
interface SharedServiceArgs {
    cluster: sst.aws.Cluster;
    network: ClusterNetwork;
    links: any[];
    permissions: LaravelArgs['permissions'];
    sitePath: Input<string>;
    absSitePath: string;
    packagePath: string;
    deployPath: string;
    workerConfPath: string;
    php?: Input<number>;
    opcache?: Input<boolean>;
    /** Variables the package adds to every container. */
    injectedEnvironment: Record<string, Input<string | undefined>>;
    vars: NonNullable<NonNullable<LaravelArgs['config']>['environment']>['vars'];
    /** The resource that writes the env file, which the images copy. */
    environmentFile?: Resource;
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
 * the scheduler dies, the container stops with its exit code and ECS
 * replaces it. Custom tasks are restarted in place.
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
     * `dependencies` lists services that must start first: other tasks of
     * the same container, `base` (s6-overlay's setup, which every task
     * depends on anyway), and on `web`, `nginx` and `php-fpm`.
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
         * Available versions: 8.1, 8.2, 8.3, 8.4, 8.5
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
    private readonly _nodes: LaravelServiceNodes;
    private readonly _messages: string[] = [];

    constructor(
        name: string,
        args: LaravelArgs,
        opts: ComponentResourceOptions = {},
    ) {
        super(__pulumiType, name, args, opts);

        const sitePath = args.path ?? '.';
        const absSitePath = path.resolve(sitePath.toString());
        const packagePath = getPackagePath();
        // SST sets __dirname to the .sst/platform directory. Each component
        // gets its own folder, so two of them don't overwrite each other.
        const buildPath = path.resolve(__dirname, '../laravel', name);
        const deployPath = path.resolve(buildPath, 'deploy');
        const workerConfPath = path.resolve(buildPath, 'conf');
        const reverb = resolveReverbArgs(args.reverb);

        // Checks the options before anything is created or written.
        const plans = planServices(name, args, { sitePath, buildPath, reverb });

        fs.mkdirSync(deployPath, { recursive: true });

        const reverbEnvironment = buildReverbEnvironment(reverb);
        const environmentFile = prepareEnvironmentFile({
            parent: this,
            name,
            envFilePath: path.resolve(deployPath, '.env'),
            absSitePath,
            environment: args.config?.environment,
            links: args.link,
            variables: reverbEnvironment,
            appUrl: getAppUrl(args.web?.domain),
            messages: this._messages,
        });

        stageDeploymentScript(
            absSitePath,
            args.config?.deployment?.script as string | undefined,
            deployPath,
        );

        if (plans.some((plan) => plan.image === 'worker')) {
            stageWorkerConf(packagePath, workerConfPath);
        }

        const network = resolveClusterNetwork(args.vpc);
        const cluster = new sst.aws.Cluster(
            `${name}-Cluster`,
            {
                vpc: network.vpc,
                forceUpgrade: args.forceUpgrade,
                transform: args.transform,
            },
            { parent: this, aliases: CREATED_WITHOUT_PARENT },
        );

        this._nodes = { cluster, workers: {} };

        const shared: SharedServiceArgs = {
            cluster,
            network,
            links: linkResources(args.link),
            permissions: args.permissions,
            sitePath,
            absSitePath,
            packagePath,
            deployPath,
            workerConfPath,
            php: args.config?.php,
            opcache: args.config?.opcache,
            injectedEnvironment:
                args.config?.environment?.autoInject !== false
                    ? reverbEnvironment
                    : {},
            vars: args.config?.environment?.vars,
            environmentFile,
        };

        for (const plan of plans) {
            const service = this.createService(plan, shared);

            if (plan.kind === 'worker') {
                this._nodes.workers[plan.workerName!] = service;
            } else {
                this._nodes[plan.kind] = service;
            }
        }

        this.registerOutputs({ _hint: this.messages });
    }

    private createService(
        plan: ServicePlan,
        shared: SharedServiceArgs,
    ): sst.aws.Service {
        writeS6TaskFiles(plan.tasks, plan.buildPath);

        const image = buildImage({
            role: plan.image,
            sitePath: shared.sitePath,
            absSitePath: shared.absSitePath,
            packagePath: shared.packagePath,
            php: shared.php,
            opcache: shared.opcache,
            servicesPath: plan.buildPath,
            deployPath: shared.deployPath,
            confPath:
                plan.image === 'worker' ? shared.workerConfPath : undefined,
        });

        const dockerIgnoreMessage = ensureDockerIgnore(
            image.context.toString(),
            image.dockerfile,
        );

        if (dockerIgnoreMessage) {
            this._messages.push(dockerIgnoreMessage);
        }

        const transform = composeTransforms(
            buildLoadBalancerHardening(
                this,
                plan.label,
                plan.resourceName,
                plan.loadBalancerOptions,
                plan.loadBalancer,
            ),
            plan.transform,
        );

        return new sst.aws.Service(
            plan.resourceName,
            {
                cluster: shared.cluster,
                link: shared.links,
                permissions: shared.permissions,
                ...plan.serviceArgs,
                image,
                environment: buildContainerEnvironment(
                    shared.injectedEnvironment,
                    shared.vars,
                    plan.environment,
                ),
                scaling: plan.scaling,
                loadBalancer: plan.loadBalancer as ServiceArgs['loadBalancer'],
                dev: {
                    command: plan.devCommand,
                },
                transform: {
                    ...transform,
                    service: withContainerNetwork(
                        shared.network,
                        transform.service,
                    ) as ServiceResourceTransform,
                    image: managedImageTransform(shared.environmentFile, transform.image),
                    taskDefinition: disableInitProcess,
                },
            },
            {
                parent: this,
                aliases: CREATED_WITHOUT_PARENT,
                dependsOn: shared.environmentFile
                    ? [shared.environmentFile]
                    : [],
            },
        );
    }

    /**
     * The URL of the web service.
     *
     * If `web.domain` is set, this is the URL with the custom domain.
     * Otherwise, it's the auto-generated load balancer URL.
     * `undefined` when no `web` service is configured.
     */
    public get url() {
        return this._nodes.web?.url;
    }

    /**
     * The URL of the Reverb service.
     *
     * If `reverb.domain` is set, this is the URL with the custom domain.
     * Otherwise, it's the auto-generated load balancer URL.
     * `undefined` when no `reverb` service is configured.
     */
    public get reverbUrl() {
        return this._nodes.reverb?.url;
    }

    /**
     * Return this in `sst.config.ts` outputs as `deployment: app.deployment`.
     * The CLI verifies these exact services and task definitions, including
     * their ECR images. External tasks can opt in by adding their task
     * definition ARNs to `taskDefinitions` in the returned object.
     */
    public get deployment(): LaravelDeployment {
        return {
            version: 1 as const,
            app: $app.name,
            stage: $app.stage,
            services: $dev ? [] : [this._nodes.web, ...Object.values(this._nodes.workers), this._nodes.reverb]
                .filter((service): service is sst.aws.Service => service !== undefined)
                .map((service) => ({
                    cluster: this._nodes.cluster.nodes.cluster.arn,
                    service: service.nodes.service.arn,
                    taskDefinition: service.nodes.taskDefinition.arn,
                })),
            taskDefinitions: [] as Input<string>[],
        };
    }

    /**
     * The underlying resources: the ECS cluster and the `sst.aws.Service`
     * of web, Reverb, and each worker (by worker name). Use them to add
     * alarms, permissions, or outputs of your own.
     *
     * @example
     * ```js
     * const app = new LaravelService('MyLaravelApp', { ... });
     *
     * return {
     *   cluster: app.nodes.cluster.nodes.cluster.name,
     *   queue: app.nodes.workers.queue.service,
     * };
     * ```
     */
    public get nodes(): LaravelServiceNodes {
        return this._nodes;
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
