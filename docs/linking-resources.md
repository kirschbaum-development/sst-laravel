# Linking Resources

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

## PlanetScale

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

## Custom environment key names

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

## Disabling the auto-inject of environment variables

If you don't want SST Laravel to auto-inject environment variables, you can disable it with the following option:

```js
config: {
  environment: {
    autoInject: false,
  }
}
```

## IAM roles and permissions

The IAM permissions for the linked resources are also automatically added to the ECS IAM Execution Role, meaning your application has access to all the linked resources.
