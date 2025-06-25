/// <reference path="./../../.sst/platform/config.d.ts" />

import * as path from 'path';
import * as fs from 'fs';
import {Component} from "../../.sst/platform/src/components/component.js";
import {FunctionArgs} from "../../.sst/platform/src/components/aws/function.js";
import {ComponentResourceOptions} from "../../.sst/platform/node_modules/@pulumi/pulumi/index.js";
import {Input} from "../../.sst/platform/src/components/input.js";
import {ClusterArgs} from "../../.sst/platform/src/components/aws/cluster.js";
import {ServiceArgs} from "../../.sst/platform/src/components/aws/service.js";
import {Dns} from "../../.sst/platform/src/components/dns.js";
import {applyLinkedResourcesEnv} from "./src/laravel-env.js";

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

export interface LaravelArgs extends ClusterArgs {

  // dev?: false | DevArgs["dev"];
  path?: Input<string>;
  link?: any[];

  /**
  * If enabled, a container will be created to handle HTTP traffic.
  */
  web?: LaravelWebArgs;

  /**
  * If enabled, Laravel Scheduler will run on an isolated container.
  */
  scheduler?: boolean | {
    link?: ServiceArgs["link"],
    scaling?: ServiceArgs["scaling"],
  },

  /**
  * Queue settings.
  */
  queue?: boolean | {
    link?: ServiceArgs["link"],
    scaling?: ServiceArgs["scaling"],

    /**
    * Running horizon?
    */
    horizon?: Input<boolean>;

    /**
     * Running scheduler?
     */
    scheduler?: Input<boolean>;

    /**
     * Multiple daemons can be run in the queue.
     */
    daemons?: Input<{
      [key: string]: Input<{
        command: Input<string>;
        dependencies?: Input<string[]>;
      }>
    }>
  }

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

    const cluster = new sst.aws.Cluster(`${name}-Cluster`, {
      vpc: args.vpc
    });

    if (args.web) {
      addWebService();
    }

    if (args.queue) {
      addWorkerService();
    }

    if (args.scheduler) {
      addCliService();
    }

    function addWebService() {
      const envVariables = getEnvironmentVariables();
      console.log('envVariables', envVariables);

      const webService = new sst.aws.Service(`${name}-Web`, {
        cluster,

        /**
         * Image passed or use our default provided image.
         */
        image: getImage( args.web?.image, ImageType.Web),
        environment: envVariables,
        scaling: args.web.scaling ?? null,

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

    function addCliService() {
      const cliService = new sst.aws.Service(`${name}-Cli`, {
        cluster,

        /**
         * Image passed or use our default provided image.
         */
        image: getImage(args.web?.image, ImageType.Cli),

        environment: getEnvironmentVariables(),
        scaling: typeof args.scheduler === 'object' ? args.scheduler.scaling : undefined,

        dev: {
          command: `php ${sitePath}/artisan schedule:work`,
        },
      });
    }

    function addWorkerService() {
      const absWorkerBuildPath = path.resolve(pluginBuildPath, 'worker');

      if (typeof args.queue === 'object' && args.queue.daemons) {
        const s6RcDPath = path.resolve(absWorkerBuildPath, 'etc/s6-overlay/s6-rc.d');
        const s6UserContentsPath = path.resolve(s6RcDPath, 'user/contents.d');

        fs.mkdirSync(s6UserContentsPath, { recursive: true });

        if (args.queue.horizon) {
          fs.writeFileSync(path.join(s6UserContentsPath, 'laravel-horizon'), '');
        }

        if (args.queue.scheduler) {
          fs.writeFileSync(path.join(s6UserContentsPath, 'laravel-scheduler'), '');
        }

        Object.entries(args.queue.daemons).forEach(([name, config]) => {
          const daemonDir = path.resolve(s6RcDPath, `${name}`);
          fs.mkdirSync(daemonDir, { recursive: true });

          const scriptSrcPath = path.join(daemonDir, 'script');

          // Create the actual script file, with the command provided
          fs.writeFileSync(scriptSrcPath, `#!/command/with-contenv bash\n${config.command}`, { mode: 0o777 });

          // Create the files that s6 will execute
          fs.writeFileSync(path.join(daemonDir, 'run'), `#!/command/execlineb -P\n/etc/s6-overlay/s6-rc.d/${name}/script`, { mode: 0o777 });

          fs.writeFileSync(path.join(daemonDir, 'type'), 'longrun');
          fs.writeFileSync(path.join(daemonDir, 'dependencies'), (config.dependencies || []).join('\n'));
          fs.writeFileSync(path.join(s6UserContentsPath, name), '');
        });
      }

      const imgBuildArgs = {
        'CONF_PATH': path.resolve(nodeModulePath, 'conf').replace(absSitePath, ''),
        'CUSTOM_CONF_PATH': absWorkerBuildPath.replace(absSitePath, ''),
      };

      const workerService = new sst.aws.Service(`${name}-Worker`, {
        cluster,

        /**
         * Image passed or use our default provided image.
         */
        image: getImage(args.web?.image, ImageType.Worker, imgBuildArgs),
        scaling: typeof args.queue === 'object' ? args.queue.scaling : undefined,

        dev: {
          // TODO
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

      const content = dockerfile ? fs.readFileSync(dockerIgnore).toString() : "";

      const lines = content.split("\n");

      // SST adds it later, so we need to add it here to ensure .sst/laravel is after it and is not ignored
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
      return args.config.php ?? 8.4;
    }

    function getEnvironmentVariables() {
      applyLinkedResourcesToEnvironment();

      const env = args.config.environment || {};

      if (args.web?.domain) {
        if (typeof args.web.domain === 'string') {
          env['APP_URL'] = args.web.domain;
        }

        // figure out why TS is complaining about this
        // if (typeof args.web.domain !== 'string' && args.web.domain !== undefined) {
        //   args.config.environment['APP_URL'] = args.web.domain.name;
        // }
      }

      return env;
    }

    function applyLinkedResourcesToEnvironment() {
      const links = (args.link || []);

      args.config.environment = {
        ...args.config.environment,
        ...applyLinkedResourcesEnv(links),
      };
    };
  };
}

const __pulumiType = "sst:aws:Laravel";
// @ts-expect-error
Laravel.__pulumiType = __pulumiType;
