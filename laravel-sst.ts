/// <reference path="./../../.sst/platform/config.d.ts" />

import * as path from 'path';
import * as fs from 'fs';
import { Component } from "../../.sst/platform/src/components/component.js";
import { FunctionArgs } from "../../.sst/platform/src/components/aws/function.js";;
import { ComponentResourceOptions, Output, all, output } from "../../.sst/platform/node_modules/@pulumi/pulumi/index.js";
import { Input } from "../../.sst/platform/src/components/input.js";
import { Link } from "../../.sst/platform/src/components/link.js";
import { ClusterArgs } from "../../.sst/platform/src/components/aws/cluster.js";
import { ServiceArgs } from "../../.sst/platform/src/components/aws/service.js";
import { Dns } from "../../.sst/platform/src/components/dns.js";
import { Postgres } from "../../.sst/platform/src/components/aws/postgres.js";
import { Redis } from "../../.sst/platform/src/components/aws/redis.js";
import { Email } from "../../.sst/platform/src/components/aws/email.js";
import { applyLinkedResourcesEnv, EnvCallback, EnvCallbacks } from "./src/laravel-env.js";

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

export interface LaravelWebArgs {
  /**
   * Domain for the web layer.
   */
  domain?: Input<
    string
    | {
      name: Input<string>;
      cert?: Input<string>;
      dns?: Input<false | (Dns & {})>;
    }
  >;

  loadBalancer?: ServiceArgs["loadBalancer"];
  image?: ServiceArgs["image"];
  scaling?: ServiceArgs["scaling"];
}

export interface LaravelWorkerConfig {
  name?: Input<string>;
  link?: ServiceArgs["link"];
  scaling?: ServiceArgs["scaling"];

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
    php?: Input<Number>;
    opcache?: Input<boolean>;
    environment?: FunctionArgs["environment"];
    deployment?: {
      migrate?: Input<boolean>;
      optimize?: Input<boolean>;
      script?: Input<string>;
    };
  }
}

export class Laravel extends Component {
  constructor(
    name: string,
    args: LaravelArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    args.config = args.config ?? {};
    const sitePath = args.path ?? '.';
    const absSitePath = path.resolve(sitePath.toString());
    // TODO: We need to update sst-laravel to whatever the real package name will be.
    const nodeModulePath = path.resolve(__dirname, '../../node_modules/sst-laravel');

    // Determine the path where our plugin will save build files. SST sets __dirname to the .sst/platform directory.
    const pluginBuildPath = path.resolve(__dirname, '../laravel');

    prepareDeploymentScript();

    const cluster = new sst.aws.Cluster(`${name}-Cluster`, {
      vpc: args.vpc
    });

    if (args.web) {
      addWebService();
    }

    if (args.workers) {
      addWorkerServices();
    }

    function addWebService() {
      const envVariables = getEnvironmentVariables();
      console.log('envVariables', envVariables);

      const webService = new sst.aws.Service(`${name}-Web`, {
        cluster,

        /**
         * Image passed or use our default provided image.
         */
        image: getImage(args.web?.image, ImageType.Web),
        environment: envVariables,
        scaling: args.web?.scaling,

        loadBalancer: args.web && args.web.loadBalancer ? args.web.loadBalancer : {
          domain: args.web?.domain,
          ports: getDefaultPublicPorts(),
        },

        permissions: [
          {
            actions: ["ses:SendEmail", "ses:SendRawEmail"],
            resources: ["arn:aws:ses:us-east-1:664418955379:identity/*"]
          },
        ],

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

    function createWorkerService(workerConfig: LaravelWorkerConfig, serviceName: string, workerBuildPath: string) {
      createWorkerTasks(workerConfig, workerBuildPath);

      const imgBuildArgs = {
        'CONF_PATH': path.resolve(nodeModulePath, 'conf').replace(absSitePath, ''),
        'CUSTOM_CONF_PATH': workerBuildPath.replace(absSitePath, ''),
      };

      return new sst.aws.Service(serviceName, {
        cluster,
        image: getImage(args.web?.image, ImageType.Worker, imgBuildArgs),
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
        console.log('absWorkerBuildPath', absWorkerBuildPath);

        createWorkerService(workerConfig, `${name}-${workerName}`, absWorkerBuildPath);
      });
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

    // TODO: We have to test if it works when an image is provided in sst.config.js
    function getImage(imgFromConfig: LaravelWebArgs["image"] | null | undefined, imgType: ImageType, extraArgs: object = {}) {
      const img = imgFromConfig
        ? imgFromConfig
        : getDefaultImage(imgType, extraArgs);

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
      applyLinkedResourcesToEnvironment();

      const env = args.config?.environment || {};

      if (args.web?.domain) {
        if (typeof args.web.domain === 'string') {
          (env as any)['APP_URL'] = args.web.domain;
        }
      }

      return env;
    }

    function applyLinkedResourcesToEnvironment() {
      const links = (args.link || []);
      const resources: any[] = [];
      const customEnv: Record<string, string | Output<string>> = {};

      // Process links to separate resources and custom env callbacks
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
      args.config.environment = {
        ...args.config.environment,
        ...applyLinkedResourcesEnv(resources),
        ...customEnv,
      };
    };
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
}

const __pulumiType = "sst:aws:Laravel";
// @ts-expect-error
Laravel.__pulumiType = __pulumiType;
