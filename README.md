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

### Scheduler

By setting up the `scheduler` property, SST Laravel will automatically deploy and configure a custom container running your Laravel scheduled commands using the `php artisan schedule:work` command.

```js
const app = new Laravel('MyLaravelApp', {
    scheduler: true,
});
```

### Queue

```js
const app = new Laravel('MyLaravelApp', {
    queue: true,
});
```

### Links & Environment Variables

SST has a concept of linking resources together. By using this component, you don't need to worry (too much) about environment variables, as SST Laravel will automatically inject them into your applications using sensible defaults for Laravel (and of course you can customize them as well).

```js
const email = new sst.aws.Email("Email", { sender: "mail@example.com" });
const database = new sst.aws.Postgres('MyDatabase', { vpc });
const redis = new sst.aws.Redis("MyRedis", { vpc });

const app = new Laravel('MyLaravelApp', {
    link: [email, database, redis],
    web: {},
});
```

This will automatically inject the `DB_*`, `REDIS_*` and `MAIL_*` environment variables into your Laravel application, according to the created resources.

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

* Full queue support;
* Dev mode;
* Add better support for linked resources (Mail, Database, Redis, etc);
* DynamoDB support;
* Add more examples;
* Add support for Octane;
* Add support for Laravel Reverb;
* Automatically set up Monitors & Alerts;
* Logs;
