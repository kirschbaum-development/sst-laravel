# SST Laravel

![](https://github.com/kirschbaum-development/sst-laravel/raw/main/images/deploy.png)

SST Laravel is an unofficial extension of [SST](https://sst.dev) created by [Kirschbaum Development](https://kirschbaumdevelopment.com) to deploy your Laravel application to AWS behind a robust, reliable and scalable infrastructure, with all the power of SST.

SST is a framework that makes it easy to build modern full-stack applications on your own infrastructure.

## What gets deployed

Behind the scenes, this extension uses the SST Cluster + Service component, which deploys custom Docker containers to AWS Fargate. It all gets deployed on your own AWS account, and you have full control over the infrastructure and which services are connected to your application. 

This package deploys a full-blown infrastructure in AWS, with zero downtime deployments, as it can be seeing in the image below.

Behind the scenes, we use the powerful PHP containers from [Serverside Up](https://serversideup.net/open-source/docker-php/).

![](https://github.com/kirschbaum-development/sst-laravel/raw/main/images/diagram.png)

## Pre-requisites

1. NodeJS.
1. SST 4.17.1 or later within version 4. The `init` command installs SST if it is missing.
1. Have [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and configured.
  * Guide on how to set up IAM Credentials [here](https://sst.dev/docs/iam-credentials/).

## Installation instructions

Pull in the package using npm:

```bash
npm install @kirschbaum-development/sst-laravel --save
```

## Deploy with an AI agent

You can let your coding agent handle the full setup. Start in your Laravel application and paste this prompt:

```text
Set up SST Laravel in this Laravel app and deploy it to AWS until /up is healthy.

Steps:
1. Install the package: `npm install @kirschbaum-development/sst-laravel --save`.
2. Read the deploy guide with `npx sst-laravel guide` and follow it.
3. Run `npx sst-laravel doctor` and show me what it finds.
4. Run `npx sst-laravel init` if there is no sst.config.ts.
5. Keep the first deploy small: web only, no domain, health check at /up, env file .env.dev.
6. Before you deploy, tell me in plain words: AWS account, region, stage, what will be created, and what it costs per month. Wait for my yes.
7. Deploy with `npx sst-laravel deploy --stage dev`, then check it with `npx sst-laravel status --stage dev --url <the-url-from-the-deploy>` and show me the URL.
8. Never print secret values. Do not put AWS keys in .env files. Do not deploy to production unless I say so.

If you get stuck, show the exact error and what you checked (running tasks, health endpoint, recent logs).
```

The agent inspects the Laravel application, checks AWS access, prepares the smallest working configuration, deploys it, and verifies the live health endpoint. It does not print secret values.

## Quick start

To get started without an agent, use the `init` command:

```bash
npx sst-laravel init
```

The command also offers to install the bundled `sst-laravel` skill for later agent sessions. It uses Laravel Boost when available. Otherwise, it uses the open `skills` installer.

## Usage

To start using, you only need to import the component in your `sst.config.ts` file:

```ts
import { LaravelService } from "@kirschbaum-development/sst-laravel";
```

And now you can start using the `Laravel` SST component. All the configuration options are Typescript files with documentation, so

To check the full list of options. check [here](https://github.com/kirschbaum-development/sst-laravel/blob/main/docs/api.md). 

### Web (HTTP)

Below is an example of setting up your application to receive HTTP requests, on the `laravel-sst-demo.example.com` domain (with SSL), with auto-scaling with a max of 3 servers.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    cpu: 1024,
    memory: 2048,
    domain: {
      dns: sst.cloudflare.dns(),
      name: 'laravel-sst-demo.example.com',
    },
    scaling: {
      min: 1, 
      max: 3,
    }
  },
});
```

Check all the `web` options [here](https://github.com/kirschbaum-development/sst-laravel/blob/main/docs/api.md#web).

#### Container size

Instead of raw `cpu`/`memory` numbers, you can pick a size: `small` (0.5 vCPU / 1 GB), `medium` (1 vCPU / 2 GB), or `large` (2 vCPU / 4 GB). Setting `cpu` or `memory` directly wins over `size`.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    size: 'small',
    scaling: {
      min: 1,
      max: 3,
    }
  },
});
```

Need something SST-specific (architecture, logging, custom load balancer)? Put it under `web.advanced` — for example `web: { advanced: { architecture: 'arm64' } }`. The simple options above cover the rest.

#### Load balancer health check

Laravel ships a built-in `/up` health endpoint. Point the load balancer at it via `web.healthCheck` — a shortcut over `loadBalancer.health` that targets the default forward port for you:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: { name: 'app.example.com' },
    healthCheck: { path: '/up' },
  },
});
```

All [`loadBalancer.health` options](https://sst.dev/docs/component/aws/service/#loadbalancer-health) are supported (`interval`, `timeout`, `healthyThreshold`, `unhealthyThreshold`, `successCodes`). If you set `web.loadBalancer` explicitly, `healthCheck` is ignored — configure `loadBalancer.health` directly there.

#### HTTP to HTTPS redirect

When you configure a `domain` (which provisions an SSL certificate and an HTTPS listener), HTTP (port 80) traffic is redirected to HTTPS (port 443) by default. To keep forwarding HTTP traffic straight to your application instead, set `httpsRedirect: false`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: { name: 'app.example.com' },
    httpsRedirect: false,
  },
});
```

This has no effect when no `domain` is set, or when you provide an explicit `web.loadBalancer` (configure `loadBalancer.ports` yourself in that case).

#### Access logs

The web container runs nginx (`serversideup/php:*-fpm-nginx`), which logs every request — including the load balancer health-check pings — to stdout, where it ends up in CloudWatch. To silence those access logs, set `accessLogs: false`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    accessLogs: false,
  },
});
```

This points the serversideup `NGINX_ACCESS_LOG` variable at `/dev/null`. Error logs and the Laravel application logs are unaffected. Only the web container runs nginx, so this has no effect on workers or the Reverb service.

### Reverb

You can deploy a dedicated Laravel Reverb service for WebSocket traffic. Reverb runs as a worker-style container using `php artisan reverb:start`, but SST Laravel also attaches a load balancer so you can give it its own public domain.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
  },

  reverb: {
    domain: {
      dns: sst.cloudflare.dns(),
      name: 'ws.example.com',
    },
  },
});

return {
  url: app.url,
  reverbUrl: app.reverbUrl,
};
```

When `reverb.domain` is configured, SST Laravel automatically injects the Reverb server variables:

```env
REVERB_SERVER_HOST=0.0.0.0
REVERB_SERVER_PORT=8080
REVERB_HOST=ws.example.com
REVERB_PORT=443
REVERB_SCHEME=https
```

If you enable horizontal scaling for Reverb, make sure your Laravel application is configured for Reverb scaling with Redis.

Check all the `reverb` options [here](https://github.com/kirschbaum-development/sst-laravel/blob/main/docs/api.md#reverb).

### Workers

Beyond HTTP requests, you can set up one or more `workers` for your Laravel application. Workers are meant to run background commands like Laravel Horizon, the Laravel Scheduler or any background command you may need to run.

SST Laravel will automatically deploy and configure worker containers running your configured commands. See some examples below.


**Running the Laravel scheduler**

```js
const app = new LaravelService('MyLaravelApp', {
  workers: [
    {
      name: 'scheduler',
      scheduler: true,
    },
  ],
});
```

**Running the Laravel Horizon**

```js
const app = new LaravelService('MyLaravelApp', {
  workers: [
    {
      name: 'horizon',
      horizon: true,
    },
  ],
});
```

**Running custom commands**

```js
const app = new LaravelService('MyLaravelApp', {
  workers: [
    {
      name: 'worker',
      tasks: {
        'scheduler': {
          command: 'php artisan schedule:work',
        },
        'queue': {
          command: 'php artisan queue:work',
        },
        'pulse': {
          command: 'php artisan pulse:work',
        },
      },
    },
  ],
});
```

Check all the `workers` options [here](https://github.com/kirschbaum-development/sst-laravel/blob/main/docs/api.md#workers).

### Running background processes in the web container

For smaller applications, you can run Horizon, the scheduler, or any custom long-running command inside the web container instead of paying for a dedicated worker service. The `web` block accepts the same `horizon`, `scheduler`, and `tasks` options as `workers[]`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
    horizon: true,
    scheduler: true,
    tasks: {
      pulse: {
        command: 'php artisan pulse:work',
      },
    },
  },
});
```

A few things to keep in mind:

- Background processes share the web container's CPU and memory with nginx and PHP-FPM. If they need dedicated resources, use a `workers` entry instead.
- Unlike workers — where a dead Horizon/scheduler process halts the container so ECS replaces it — background processes in the web container are restarted in place by s6, so a crash never interrupts HTTP traffic.
- If the web service scales beyond one container, every replica runs these processes. Horizon handles this fine (shared queue), but scheduled jobs should use `onOneServer()` backed by a shared cache store to avoid running more than once.

## Environment Variables

There are multiple ways to configure environment variables. If you want SST Laravel to copy an environment file, you can configure the `config.environment.file` entry.

The below configuration would copy a file named `.env.$STAGE` (e.g. `.env.production`) into the deployment containers as your `.env` file.

### Environment File

```js
const app = new LaravelService('MyLaravelApp', {
  // ...
  config: {
    environment: {
      file: `.env.${$app.stage}`,
    }
  }
});
```

You can also configure it to use simply `.env`.

```js
const app = new LaravelService('MyLaravelApp', {
  // ...
  config: {
    environment: {
      file: `.env`,
    }
  }
});
```

### SST Secrets

You can also use SST Secrets to store your environment variables. This is a more secure way to store your environment variables.

```js
const APP_KEY = new sst.Secret("APP_KEY");
const DB_PASSWORD = new sst.Secret("DB_PASSWORD");

const app = new LaravelService('MyLaravelApp', {
  link: [APP_KEY, DB_PASSWORD],
});
```

This will automatically inject the environment variables into the `.env` file of your Laravel application. Read more about SST Secrets [here](https://sst.dev/docs/component/secret/).

### AWS Secrets Manager (RemoteEnvVault)

For a more robust environment variable management solution similar to Laravel Vapor, you can use the `RemoteEnvVault` component. This stores your environment variables in AWS Secrets Manager and provides CLI commands to push and pull secrets.

```js
import { RemoteEnvVault, LaravelService } from "@kirschbaum-development/sst-laravel";

const env = new RemoteEnvVault("Env");
const app = new LaravelService('MyLaravelApp', {
  // ...
  config: {
    environment: {
      secrets: env,
    }
  }
});
```

The secrets are stored in AWS Secrets Manager at the path `/{app-name}/{stage}/env`.

#### Large Environment Files

Large environment files that exceed AWS Secrets Manager's 64KB limit are automatically handled. The CLI will:
- Split large `.env` files into multiple chunks when pushing
- Automatically merge all chunks when pulling or deploying

This is completely transparent - you don't need to do anything special.

#### Pushing Secrets

To push your local `.env` file to AWS Secrets Manager:

```bash
# Push .env.production to the production stage
npx sst-laravel env:push --stage production --input .env.production

# Push .env to staging (interactive)
npx sst-laravel env:push --stage staging
```

#### Pulling Secrets

To pull secrets from AWS Secrets Manager to a local file:

```bash
# Pull from production to .env.production (default)
npx sst-laravel env:pull --stage production

# Pull from staging to a custom file
npx sst-laravel env:pull --stage staging --output .env.local
```

#### Deploying with Secrets

When using `RemoteEnvVault`, deploy using the `sst-laravel deploy` command which automatically fetches secrets before building:

```bash
npx sst-laravel deploy --stage production
```

#### Workflow Example

```bash
# 1. Initial setup - push your environment file
npx sst-laravel env:push --stage production --input .env.production

# 2. Deploy (secrets are automatically fetched)
npx sst-laravel deploy --stage production

# 3. Update secrets later
npx sst-laravel env:pull --stage production  # Creates .env.production
# Edit .env.production
npx sst-laravel env:push --stage production --input .env.production
npx sst-laravel deploy --stage production
```

You can also use a custom path for the secrets:

```js
const env = new RemoteEnvVault("Env", {
  path: "/custom/path/env"
});
```

### Resources

In SST, you can [link resources](https://sst.dev/docs/linking). If you link resources to your Laravel component, SST Laravel will automatically inject and configure environment variables using sensible defaults for all the linked resources.

In the example configuration below, SST Laravel will automatically inject environment variables for the database, cache and filesystem.

```js
const database = new sst.aws.Postgres('MyDatabase', { vpc });
const redis = new sst.aws.Redis("MyRedis", { vpc });
const bucket = new sst.aws.Bucket("MyBucket");

const app = new LaravelService('MyLaravelApp', {
  link: [database, redis, bucket],
});
```

The `DB_*`, `REDIS_*` and `AWS_*` environment variables will be automatically injected into your Laravel application. 

You can also [import existing resources](https://sst.dev/docs/import-resources/) into SST, in case you already have resources like databases, buckets, etc. created and in use in your AWS account.

#### PlanetScale

Wrap your PlanetScale credentials in an `sst.Linkable` and set `provider: "planetscale"`. Set `engine` to `"mysql"` (the default) for Vitess or `"postgres"` for Postgres. Connection values can come from provider resources or `sst.Secret` values.

For MySQL, follow the [SST PlanetScale guide](https://sst.dev/docs/integrations/planetscale/) to configure the provider and create a branch password. This example uses the `planetscale.Password` resource from that guide:

```ts
const database = new sst.Linkable('Database', {
  properties: {
    provider: 'planetscale',
    engine: 'mysql',
    host: password.accessHostUrl,
    database: password.database,
    username: password.username,
    password: password.plaintext,
  },
});

const app = new LaravelService('MyLaravelApp', {
  link: [database],
  config: {
    environment: {
      file: '.env.production',
    },
  },
  web: {},
});
```

For Postgres, use the credentials from a [PlanetScale Postgres role](https://planetscale.com/docs/postgres/connecting/roles). For example, if `role` is a `planetscale.PostgresBranchRole` resource:

```ts
const database = new sst.Linkable('Database', {
  properties: {
    provider: 'planetscale',
    engine: 'postgres',
    host: role.accessHostUrl,
    database: 'postgres',
    username: role.username,
    password: role.password,
  },
});
```

Use this link in the same `LaravelService` configuration. `database` is the logical Postgres database name, usually `postgres`; it is not the project name in the PlanetScale dashboard. The available provider resource names depend on your provider version.

Both engines inject `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD`. The engine sets the following defaults:

| Engine | `DB_CONNECTION` | `DB_PORT` | TLS variables |
| --- | --- | --- | --- |
| MySQL (Vitess) | `mysql` | `3306` | `MYSQL_ATTR_SSL_CA` |
| Postgres | `pgsql` | `5432` | `DB_SSLMODE=verify-full` and `DB_URL` with `sslmode` and `sslrootcert` |

Set `port` in the link properties to use another port. Set `sslCa` to change the CA bundle path. The default path is `/etc/ssl/certs/ca-certificates.crt`, which applies to the package's Debian-based containers. Passwords and the Postgres connection URL are marked as Pulumi secrets.

Laravel must retain its standard `MYSQL_ATTR_SSL_CA` option for MySQL, or `DB_URL` option for Postgres, in `config/database.php`. The Postgres URL includes the credentials and TLS settings so certificate verification also works after `php artisan config:cache`. Laravel gives URL values precedence over individual `DB_*` values. To change Postgres credentials, change the link properties or override the full `DB_URL` in an `envFrom` callback.

This also works with `config.environment.secrets` (`RemoteEnvVault`). Set `config.environment.autoInject: false` to disable injection. Only links with the explicit `provider: 'planetscale'` property use these defaults.

#### Custom Environment Key Names

If you need to customize the environment variable names for your resources, you can provide an object with the resource and a callback function in the `link` array:

```js
const app = new LaravelService('MyLaravelApp', {
  link: [
    email, 
    {
      resource: database,
      envFrom: (database: sst.aws.Postgres) => ({
        CUSTOM_DB_HOST: database.host.apply(host => host.toString()),
        CUSTOM_DB_NAME: database.database.apply(database => database.toString()),
        CUSTOM_DB_USER: database.username.apply(username => username.toString()),
        CUSTOM_DB_PASSWORD: database.password.apply(password => password.toString()),
      })
    },
    {
      resource: redis,
      envFrom: (redis: sst.aws.Redis) => ({
        QUEUE_CONNECTION: 'redis',
        QUEUE_REDIS_HOST: redis.host.apply(host => host ? `tls://${host}` : ''),
        QUEUE_REDIS_PORT: redis.port.apply(port => port.toString()),
      })
    }
  ],
  web: {}
});
```

The callback function receives the resource as a parameter and should return an object with the custom environment variables. The default environment variables are still set, so you can either override them or add new ones. (The older `environment` name for this callback still works.)

#### Disabling the auto-inject of environment variables

If you don't want SST Laravel to auto-inject environment variables, you can disable with the following option:

```js
config: {
  environment: {
    autoInject: false,
  }
}
```

#### IAM Roles and Permissions

The IAM permissions for the linked resources are also automatically added to the ECS IAM Execution Role, meaning your application has access to all the linked resources.

### Other Configurations

You can configure the PHP version, custom environment variables and a custom deployment script.

```js
const app = new LaravelService('MyLaravelApp', {
  config: {
    php: 8.4,
    opcache: true,
    deployment: {
      script: './infra/deploy.sh'
    },
  },
});
```

Custom deployment script example:

```bash
#!/bin/sh

# Exit on error
set -e

echo "🚀 Running Deployment Script..."

cd "$APP_BASE_DIR"

echo "🚀 Running PHP Artisan Optimize..."
php artisan optimize

echo "🚀 Running Laravel Migrations..."
php artisan migrate --force
```

## Deploying

To deploy your application, you can use the `sst-laravel deploy` command. You must be authenticated with AWS in your terminal session to deploy.

```bash
npx sst-laravel deploy --stage {stage}
npx sst-laravel deploy --stage sandbox
npx sst-laravel deploy --stage production
```

> **Note:** If you're using `RemoteEnvVault` for secrets management, you should use `sst-laravel deploy` instead of `sst deploy` directly. This ensures secrets are fetched from AWS Secrets Manager before the Docker build.

## Readiness and Status

Before deploying, check that the machine and app are ready:

```bash
npx sst-laravel doctor
```

It checks that the package is installed, tool versions, AWS login and region, Laravel drivers, trusted proxies, `sst.config.ts`, and that stage env files are ignored by git. It never prints secret values.

AI agents can print the full deploy guide with `npx sst-laravel guide`, or the short config reference with `npx sst-laravel guide --reference`.

After deploying, check everything in one view (running tasks plus the `/up` health endpoint):

```bash
npx sst-laravel status --stage production --url https://app.example.com
```

## Accessing Containers

Using the `sst-laravel` CLI tool, you can easily connect to your running ECS containers for debugging and troubleshooting.

```bash
npx sst-laravel ssh --stage production
```

This will list all running tasks in your cluster and let you choose which one to connect to.

**Connect to a specific service:**

```bash
npx sst-laravel ssh web --stage production
npx sst-laravel ssh worker --stage production
npx sst-laravel ssh reverb --stage production
```

If you are naming your workers differently, you can specify the worker name:

```bash
npx sst-laravel ssh {worker-name} --stage production
npx sst-laravel ssh worker --stage production
```

## Logs

You can view the logs for your application using the `sst-laravel logs` command.

```bash
npx sst-laravel logs {service} --stage production
npx sst-laravel logs web --stage production
npx sst-laravel logs reverb --stage production
npx sst-laravel logs worker --stage production
```

This will show the logs for your application in real-time.

**LOG_CHANNEL**

To send logs to AWS CloudWatch, you need to set the `LOG_CHANNEL` environment variable to `stderr`. In case this variable is not set in your specified environment file, SST Laravel will automatically add it to the environment file with the value of `stderr`.

## Troubleshooting

**Load Balancer and trusted proxies**

SST Laravel puts the container behind a load balancer, so you must configure your Laravel application to trust the load balancer's IP addresses. You can do this by configuring the trusted proxies in `bootstrap/app.php`. If you deployed your app and it's trying to load assets using HTTP instead of HTTPS, this is likely the issue.

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '*');
})
```

**Failed to build sst.config.ts**

In case you get the following error when running SST commands, run `npx sst-laravel install`. If this fails, temporarily rename the `sst.config.ts` file, and run `npx sst install`.

```bash
✕  Failed to build sst.config.ts
   - node_modules/@kirschbaum-development/sst-laravel/laravel-sst.ts:6:26 Could not resolve "../../../.sst/platform/src/components/component.js"
```

**CD: AWS credentials are not configured**

If you are getting the following error when deploying (usually via CI/CD), the issue is usually that you have a `.env` or `.env.{stage}` that contains the `AWS_ACCESS_KEY_ID` and 
`AWS_SECRET_ACCESS_KEY` keys. They should be removed from the environment file and you should be relying on the IAM role to give your app permissions to access AWS resources (which is more secure anyway).

```
✕  AWS credentials are not configured. Try configuring your profile in `~/.aws/config` and setting the `AWS_PROFILE` environment variable or specifying `providers.aws.profile` in your sst.config.ts
   aws: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, failed to get API token, operation error ec2imds: getToken, http response error StatusCode: 400, request to EC2 IMDS failed
```

**APP_URL**

In case your specified environment file does not contain the `APP_URL` variable, SST Laravel will automatically add it to the environment file with the value of the `web.domain` property.

***

### Roadmap

* Ability to extend base Docker images;
* Add support for Inertia SSR;
* Add support for Octane with FrankedPHP;
* Dev mode;
* ...what else are we missing?

## Security

If you discover any security related issues, please email security@kirschbaumdevelopment.com instead of using the issue tracker.

## Sponsorship

Development of this package is sponsored by Kirschbaum Development Group, a developer driven company focused on problem solving, team building, and community. Learn more [about us](https://kirschbaumdevelopment.com) or [join us](https://careers.kirschbaumdevelopment.com)!

## License

The MIT License (MIT). Please see [License File](LICENSE.md) for more information.
