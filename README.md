# Laravel SST

This is an unofficial extension of SST to help you deploy Laravel applications with all the power the SST provides.

### Installation instructions

### HTTP

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

By setting up the `scheduler`, Laravel SST will automatically deploy and configure a custom container running your Laravel scheduled commands using the `php artisan schedule:work` command.

```js
const app = new Laravel('MyLaravelApp', {
    scheduler: true,
});
```

### Queue

```js
const app = new Laravel('MyLaravelApp', {
    queue: {
        horizon: true,
    },
});
```

### Links & Environment Variables

SST has a really cool concept of linking resources together. By using this with SST, you basically do not need to worry (too much) about environment variables, as SST will automatically inject them into your applications. This package extends this concept to Laravel, by automatically injecting the environment variables of your linked resources in a configurable way (given you can have different environment variable names in your Laravel app).

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
        php: 8.3,
        environment: {
            AWS_ACCESS_KEY_ID: 'xxx',
        },
        deployment: {
            script: './infra/deploy.sh'
        },
    },
});
```
