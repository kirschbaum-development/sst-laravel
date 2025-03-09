/// <reference path="./../../.sst/platform/config.d.ts" />

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
import { applyLinkedResourcesEnv } from "./src/laravel-env.js";

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
  scaling: ServiceArgs["scaling"];
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

    const parent = this;
    const sitePath = args.path ?? '.';
    args.config = args.config ?? {};

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
        image: args.web && args.web.image
          ? args.web.image
          : getDefaultImage(ImageType.Web),
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
        image: args.web && args.web.image ? args.web.image : getDefaultImage(ImageType.Cli),

        environment: getEnvironmentVariables(),
        scaling: typeof args.scheduler === 'object' ? args.scheduler.scaling : undefined,

        dev: {
          command: `php ${sitePath}/artisan schedule:work`,
        },
      });
    }

    function addWorkerService() {
      const workerService = new sst.aws.Service(`${name}-Worker`, {
        cluster,

        /**
         * Image passed or use our default provided image.
         */
        image: args.web && args.web.image ? args.web.image : getDefaultImage(ImageType.Worker),
        scaling: typeof args.queue === 'object' ? args.queue.scaling : undefined,

        dev: {
          command: `php ${sitePath}/artisan horizon`,
        },
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

    function getDefaultImage(imageType: ImageType, extraArgs: object = {}) {
      return {
        context: sitePath,
        dockerfile: `./infra/laravel-sst/Dockerfile.${imageType}`,
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
