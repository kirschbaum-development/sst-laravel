# SST Laravel

This is an unofficial extension of SST to help you deploy Laravel applications with all the power the SST provides.

## What it deploys

Behind the scenes, this extension uses the SST Cluster + Service component, which runs in AWS Fargate using some pre-built Docker containers.

### Installation instructions

Pull in the package using npm:

```bash
npm install @kirschbaum/sst-laravel
```

Import the component in your `sst.config.ts` file:

```ts
import { Laravel } from "@kirschbaum-development/sst-laravel";
```

And now you can start using the `Laravel` SST component.

### HTTP

Setting up your app to run receive HTTP requests, on the `laravel-sst-demo.kdg.dev` domain (with SSL), with auto-scaling with a max of 3 servers.

```js
const app = new Laravel('MyLaravelApp', {
    web: {
        domain: 'laravel-sst-demo.kdg.dev',
        scaling: {
            min: 1, 
            max: 3,
        }
    },
});
```

### Workers

By setting up the `workers` property, SST Laravel will automatically deploy and configure a custom container running your Laravel scheduled commands using the `php artisan schedule:work` command.

```js
const app = new Laravel('MyLaravelApp', {
    workers: [
        {
            name: 'scheduler',
            scheduler: true,
        },
    ],
});
```

You can also set up a Horizon worker by setting the `horizon` property to `true`.

```js
const app = new Laravel('MyLaravelApp', {
    workers: [
        {
            name: 'horizon',
            horizon: true,
        },
    ],
});
```

But you can actually set up any command you want to run in the worker by setting the `tasks` property.

```js
const app = new Laravel('MyLaravelApp', {
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
                'reverb': {
                    command: 'php artisan reverb:start',
                },
            },
        },
    ],
});
```

### Links & Environment Variables

SST has a concept of [linking resources](https://sst.dev/docs/linking) together. By using this component, you don't need to worry (too much) about environment variables, as SST Laravel will automatically inject them into your applications using sensible defaults for Laravel (and of course you can customize them as you wish).

```js
const database = new sst.aws.Postgres('MyDatabase', { vpc });
const redis = new sst.aws.Redis("MyRedis", { vpc });
const bucket = new sst.aws.Bucket("MyBucket");

const app = new Laravel('MyLaravelApp', {
    link: [database, redis, bucket],
    web: {},
});
```

This will automatically inject the `DB_*`, `REDIS_*` and `AWS_*` environment variables into your Laravel application, according to the created resources. The IAM permissions for the linked resources are also automatically added to the ECS IAM Role.

#### Custom Environment Key Names

If you need to customize the environment variable names, you can provide an object with the resource and a callback function in the `link` array:

```js
const app = new Laravel('MyLaravelApp', {
    link: [
        email, 
        {
            resource: database,
            environment: (resource) => ({
                // Custom environment variables for Postgres
                CUSTOM_DB_HOST: resource.host,
                CUSTOM_DB_NAME: resource.database,
                CUSTOM_DB_USER: resource.username,
                CUSTOM_DB_PASSWORD: resource.password,
            })
        },
        {
            resource: redis,
            environment: (resource) => ({
                // Custom environment variables for Redis
                CUSTOM_REDIS_HOST: resource.host.apply(host => host ? `tls://${host}` : ''),
                CUSTOM_REDIS_PORT: resource.port.apply(port => port.toString()),
            })
        }
    ],
    web: {}
});
```

The callback function receives the resource as a parameter and should return an object with the custom environment variables. The default environment variables are still set, so you can either override them or add new ones.

### Extra configurations

You can configure the PHP version, custom environment variables and a custom deployment script.

```js
const app = new Laravel('MyLaravelApp', {
    config: {
        php: 8.4,
        opcache: true,
        environment: {
            AWS_ACCESS_KEY_ID: 'xxx',
        },
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

### Roadmap/Ideas

* Automatically add permissions to the ECS IAM Role for linked resources;
* Dev mode;
* Add better support for linked resources (Mail, Database, Redis, etc);
* Add support for Octane;
* Add support for Laravel Reverb;
* Logs;
