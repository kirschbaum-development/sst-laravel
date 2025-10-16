/// <reference path="./../../../.sst/platform/config.d.ts" />

import * as path from 'path';
import * as fs from 'fs';
import { Component } from "../../../.sst/platform/src/components/component.js";
import { FunctionArgs } from "../../../.sst/platform/src/components/aws/function.js";;
import { ComponentResourceOptions, Output, all, output } from "@pulumi/pulumi";
import { Input } from "../../../.sst/platform/src/components/input.js";
import { ClusterArgs } from "../../../.sst/platform/src/components/aws/cluster.js";
import { ServiceArgs } from "../../../.sst/platform/src/components/aws/service.js";
import { Dns } from "../../../.sst/platform/src/components/dns.js";
import { applyLinkedResourcesEnv, EnvCallback, EnvCallbacks } from "./src/laravel-env";

// duplicate from cluster.ts
type Port = `${number}/${"http" | "https" | "tcp" | "udp" | "tcp_udp" | "tls"}`;

type Ports = {
  listen: Port,
  forward: Port
}[];

enum ImageType {
  Web = 'web',
  Worker = 'worker',
  Cli = 'cli',
}

export interface LaravelServiceArgs {
  architecture?: ServiceArgs["architecture"];
  cpu?: ServiceArgs["cpu"];
  memory?: ServiceArgs["memory"];
  storage?: ServiceArgs["storage"];
  loadBalancer?: ServiceArgs["loadBalancer"];
  scaling?: ServiceArgs["scaling"];
  logging?: ServiceArgs["logging"];
  health?: ServiceArgs["health"];
  executionRole?: ServiceArgs["executionRole"];
  permissions?: ServiceArgs["permissions"];
}

export interface LaravelWebArgs extends LaravelServiceArgs {
  /**
   * Custom domain for the web layer. (if you don't provide a domain name, you will be able to use the load balancer domain for testing (http only))
   */
  domain?: Input<
    string
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
    }>
  }>
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
      file?: Input<string>,

      /**
       * Set this to false in case you don't want to auto inject environment variables from your linked resources.
       *
       * @default `true`
       */
      autoInject?: Input<boolean>,

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
      vars?: FunctionArgs["environment"],
    };

    /**
     * Custom deployment configurations.
     */
    deployment?: {
      // migrate?: Input<boolean>;
      // optimize?: Input<boolean>;
      script?: Input<string>;
    };
  }
}

export class LaravelService extends Component {
  private readonly services: Record<string, sst.aws.Service>;

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
    const nodeModulePath = path.resolve(__dirname, '../../node_modules/@kirschbaum-development/sst-laravel');

    // Determine the path where our plugin will save build files.
    // SST sets __dirname to the .sst/platform directory.
    const pluginBuildPath = path.resolve(__dirname, '../laravel');

    if (!fs.existsSync(pluginBuildPath)) {
      fs.mkdirSync(pluginBuildPath, { recursive: true });
    }

    if (!fs.existsSync(pluginBuildPath + '/deploy')) {
      fs.mkdirSync(pluginBuildPath + '/deploy', { recursive: true });
    }

    prepareEnvironmentFile();
    prepareDeploymentScript();

    const cluster = new sst.aws.Cluster(`${name}-Cluster`, {
      vpc: args.vpc
    });

    const addWebService = () => {
      const envVariables = getEnvironmentVariables();

      this.services['web'] = new sst.aws.Service(`${name}-Web`, {
        cluster,
        link: getLinks(),
        permissions: args.permissions,

        /**
         * Image passed or use our default provided image.
         */
        image: getImage(ImageType.Web),
        environment: envVariables,
        scaling: args.web?.scaling,

        loadBalancer: args.web && args.web.loadBalancer ? args.web.loadBalancer : {
          domain: args.web?.domain,
          ports: getDefaultPublicPorts(),
        },

        dev: {
          command: `php ${sitePath}/artisan serve`,
        },
      });
    }

    function createWorkerTasks(workerConfig: LaravelWorkerConfig, workerBuildPath: string) {
      const s6RcDPath = path.resolve(workerBuildPath, 'etc/s6-overlay/s6-rc.d');
      const s6UserContentsPath = path.resolve(s6RcDPath, 'user/contents.d');

      fs.mkdirSync(s6UserContentsPath, { recursive: true });

      const tasks: Record<string, { command: string; dependencies?: string[] }> = {
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

        fs.writeFileSync(scriptSrcPath, `#!/command/with-contenv bash\ncd /var/www/html\n${config.command}`, { mode: 0o777 });
        fs.writeFileSync(path.join(tasksDir, 'run'), `#!/command/execlineb -P\n/etc/s6-overlay/s6-rc.d/${taskName}/script`, { mode: 0o777 });
        fs.writeFileSync(path.join(tasksDir, 'type'), 'longrun');
        fs.writeFileSync(path.join(tasksDir, 'dependencies'), (config.dependencies || []).join('\n'));
        fs.writeFileSync(path.join(s6UserContentsPath, taskName), '');
      });
    }

    const createWorkerService = (workerConfig: LaravelWorkerConfig, serviceName: string, workerBuildPath: string) => {
      createWorkerTasks(workerConfig, workerBuildPath);

      const imgBuildArgs = {
        'CONF_PATH': path.resolve(nodeModulePath, 'conf').replace(absSitePath, ''),
        'CUSTOM_CONF_PATH': workerBuildPath.replace(absSitePath, ''),
      };

      this.services[serviceName] = new sst.aws.Service(serviceName, {
        cluster,
        link: getLinks(),
        permissions: args.permissions,

        image: getImage(ImageType.Worker, imgBuildArgs),
        scaling: workerConfig.scaling,
        environment: getEnvironmentVariables(),

        dev: {
          command: `php ${sitePath}/artisan horizon`,
        },

        transform: {
          taskDefinition: (args) => {
            args.containerDefinitions = (args.containerDefinitions as $util.Output<string>).apply(a => {
              return JSON.stringify([{
                ...JSON.parse(a)[0],
                linuxParameters: {
                  initProcessEnabled: false,
                }
              }]);
            })
          }
        }
      }, {
        dependsOn: [],
      });
    }

    function addWorkerServices() {
      args.workers?.forEach((workerConfig, index) => {
        const workerName = workerConfig.name || `worker-${index + 1}`;
        const absWorkerBuildPath = path.resolve(pluginBuildPath, `worker-${workerName}`);

        createWorkerService(workerConfig, `${name}-${workerName}`, absWorkerBuildPath);
      });
    }

    if (args.web) {
      addWebService();
    }

    if (args.workers) {
      addWorkerServices();
    }

    function getDefaultPublicPorts(): Ports {
      let ports;
      const forwardPort: Port = "8080/http";
      const portHttp: Port = "80/http";
      const portHttps: Port = "443/https";

      if (args.web?.domain) {
        ports = [
          { listen: portHttp, forward: forwardPort },
          { listen: portHttps, forward: forwardPort },
        ];
      } else {
        ports = [
          { listen: portHttp, forward: forwardPort },
        ];
      }

      return ports;
    }

    // TODO: We have to test if it works when a custom image is provided in sst.config.js
    function getImage(imgType: ImageType, extraArgs: object = {}) {
      const img = getDefaultImage(imgType, extraArgs);

      const context = typeof img === 'string'
        ? sitePath.toString()
        : (img as { context: string }).context.toString();

      const dockerfile = typeof img === 'string'
        ? 'Dockerfile'
        : (img as { dockerfile: string }).dockerfile;

      // add .sst/laravel to .dockerignore if not exist
      const dockerIgnore = (() => {
        let filePath = path.join(context, `${dockerfile}.dockerignore`);
        if (fs.existsSync(filePath)) return filePath;

        filePath = path.join(context, ".dockerignore");
        if (fs.existsSync(filePath)) return filePath;
      })();

      const content = dockerIgnore ? fs.readFileSync(dockerIgnore).toString() : "";

      const lines = content.split("\n");

      // SST adds it later, so we need to add it here to ensure .sst/laravel is after it and is not ignored
      if (dockerIgnore) {
        if (!lines.find((line) => line === ".sst")) {
          fs.writeFileSync(
            dockerIgnore,
            [...lines, "", "# sst", "!.sst/laravel"].join("\n"),
          );
        }

        if (!lines.find((line) => line === "!.sst/laravel")) {
          fs.writeFileSync(
            dockerIgnore,
            [...lines, "", "# sst-laravel", "!.sst/laravel"].join("\n"),
          );
        }
      }

      return img;
    }

    function getDefaultImage(imageType: ImageType, extraArgs: object = {}) {
      return {
        context: sitePath,
        dockerfile: path.resolve(nodeModulePath, `Dockerfile.${imageType}`).replace(absSitePath, '.'),
        args: {
          'PHP_VERSION': getPhpVersion().toString(),
          'PHP_OPCACHE_ENABLE': args.config?.opcache? '1' : '0',
          'AUTORUN_LARAVEL_MIGRATION': imageType === ImageType.Web ? 'true' : 'false',
          'CONTAINER_TYPE': imageType,
          'ENV_FILENAME': args.config?.environment?.file ?? '.env',
          stage: "deploy",
          platform: "linux/amd64",
          ...extraArgs
        },
      };
    };

    function getPhpVersion() {
      return args.config?.php ?? 8.4;
    }

    function getEnvironmentVariables() {
      const env = args.config?.environment?.vars || {};

      if (args.web?.domain) {
        if (typeof args.web.domain === 'string') {
          (env as any)['APP_URL'] = `https://${args.web.domain}`;
        }
      }

      return env;
    }

    function applyLinkedResourcesToEnvironment() {
      const links = (args.link || []);
      const resources: any[] = [];
      const customEnv: Record<string, string | Output<string>> = {};

      links.forEach(link => {
        if (link && typeof link === 'object' && 'resource' in link) {
          // Link is an object with resource and optional envCallback
          resources.push(link.resource);

          // If there's an envCallback, call it and merge the result
          if (link.envCallback) {
            const callbackResult = link.envCallback(link.resource);
            Object.assign(customEnv, callbackResult);
          }
        } else {
          // Link is just a resource
          resources.push(link);
        }
      });

      // Apply default environment variables for all resources
      if (!args.config) args.config = {};
      if (!args.config.environment) args.config.environment = {};

      const resourcesEnvVars = {
        ...applyLinkedResourcesEnv(resources),
        ...customEnv,
      };

      const envFile = path.resolve(pluginBuildPath, 'deploy', '.env');

      all(Object.entries(resourcesEnvVars)).apply(entries => {
        const envContent = entries
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');

        if (envContent) {
          fs.appendFileSync(envFile, '\n' + envContent);
        }
      });
    };

    /**
     * Return the links as an array of resources in the original SST format.
     */
    function getLinks(): any[] {
      return (args.link || []).map(link => {
        if (link && typeof link === 'object' && 'resource' in link) {
          return link.resource;
        }

        return link;
      });
    }

    function prepareEnvironmentFile() {
      const envFile = args.config?.environment?.file as string | undefined;

      if (! envFile) {
        return;
      }

      const envDir = path.resolve(pluginBuildPath, 'deploy');
      const dst = path.resolve(envDir, '.env');
      const src = path.resolve(absSitePath, envFile);

      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
      } else {
        fs.writeFileSync(dst, '');
      }

      if (! args.config?.environment?.autoInject === false) {
        applyLinkedResourcesToEnvironment();
      }
    }

    function prepareDeploymentScript() {
      const deployDir = path.resolve(pluginBuildPath, 'deploy');
      const dst = path.resolve(deployDir, '60-deploy.sh');

      fs.mkdirSync(deployDir, { recursive: true });

      const script = args.config?.deployment?.script as string | undefined;
      if (script) {
        const src = path.resolve(absSitePath, script);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          fs.chmodSync(dst, 0o755);
          return;
        }
      }

      fs.writeFileSync(dst, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(dst, 0o755);
    }
  };

  /**
   * The URL of the service.
   *
   * If `public.domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated load balancer URL.
   */
  public get url() {
    return this.services['web'].url;
  }
}

const __pulumiType = "sst:aws:LaravelService";
// @ts-expect-error
LaravelService.__pulumiType = __pulumiType;
