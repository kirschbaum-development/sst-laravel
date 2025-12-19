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
1. Have [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and configured.
  * Guide on how to set up IAM Credentials [here](https://sst.dev/docs/iam-credentials/).

## Installation instructions

Pull in the package using npm:

```bash
npm install @kirschbaum-development/sst-laravel --save
```

## Quick start

To get started quickly, you can use the `init` command:

```bash
npx sst-laravel init
```

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

## Environment Variables

There are multiple ways to configure environment variables. If you want SST Laravel to copy an environment file, you can configure the `config.environment.file` entry.

The below configuration would copy a file named `.env.$STAGE` (e.g. `.env.production`) into the deployment containers as your `.env` file.

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

#### Custom Environment Key Names

If you need to customize the environment variable names for your resources, you can provide an object with the resource and a callback function in the `link` array:

```js
const app = new LaravelService('MyLaravelApp', {
  link: [
    email, 
    {
      resource: database,
      environment: (database: sst.aws.Postgres) => ({
        CUSTOM_DB_HOST: database.host.apply(host => host.toString()),
        CUSTOM_DB_NAME: database.database.apply(database => database.toString()),
        CUSTOM_DB_USER: database.username.apply(username => username.toString()),
        CUSTOM_DB_PASSWORD: database.password.apply(password => password.toString()),
      })
    },
    {
      resource: redis,
      environment: (redis: sst.aws.Redis) => ({
        QUEUE_CONNECTION: 'redis',
        QUEUE_REDIS_HOST: redis.host.apply(host => host ? `tls://${host}` : ''),
        QUEUE_REDIS_PORT: redis.port.apply(port => port.toString()),
      })
    }
  ],
  web: {}
});
```

The callback function receives the resource as a parameter and should return an object with the custom environment variables. The default environment variables are still set, so you can either override them or add new ones.

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

To deploy your application, you can use the `sst deploy` command. You must be authenticated with AWS in your terminal session to deploy.

```bash
npx sst-laravel deploy --stage {stage}
npx sst-laravel deploy --stage sandbox
npx sst-laravel deploy --stage production
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
npx sst-laravel logs worker --stage production
```

This will show the logs for your application in real-time.

**LOG_CHANNEL**

To send logs to AWS CloudWatch, you need to set the `LOG_CHANNEL` environment variable to `stderr`. In case this variable is not set in your specified environment file, SST Laravel will automatically add it to the environment file with the value of `stderr`.

## Troubleshooting

**APP_URL**

In case your specified environment file does not contain the `APP_URL` variable, SST Laravel will automatically add it to the environment file with the value of the `web.domain` property.

**Load Balancer and trusted proxies**

SST Laravel puts the container behind a load balancer, so you must configure your Laravel application to trust the load balancer's IP addresses. You can do this by configuring the trusted proxies in `bootstrap/app.php`. If you deployed your app and it's trying to load assets using HTTP instead of HTTPS, this is likely the issue.

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '*');
    $middleware->trustProxies(headers: Request::HEADER_X_FORWARDED_FOR |
        Request::HEADER_X_FORWARDED_HOST |
        Request::HEADER_X_FORWARDED_PORT |
        Request::HEADER_X_FORWARDED_PROTO |
        Request::HEADER_X_FORWARDED_AWS_ELB
    );
})
```

**Failed to build sst.config.ts**

In case you get the following error when running SST commands, run `npx sst-laravel install`. If this fails, temporarily rename the `sst.config.ts` file, and run `npx sst install`.

```bash
✕  Failed to build sst.config.ts
   - node_modules/@kirschbaum-development/sst-laravel/laravel-sst.ts:6:26 Could not resolve "../../../.sst/platform/src/components/component.js"
```

***

### Roadmap

* Support for [SST Secrets](https://sst.dev/docs/component/secret/);
* Extend base Docker images;
* Add support for Inertia SSR;
* Add support for Octane with FrankedPHP;
* Add support for Laravel Reverb;
* Dev mode;
* ...what else are we missing?

## Security

If you discover any security related issues, please email security@kirschbaumdevelopment.com instead of using the issue tracker.

## Sponsorship

Development of this package is developed and sponsored by Kirschbaum Development Group, a developer driven company focused on problem solving, team building, and community. Learn more [about us](https://kirschbaumdevelopment.com) or [join us](https://careers.kirschbaumdevelopment.com)!

## License

The MIT License (MIT). Please see [License File](LICENSE.md) for more information.
