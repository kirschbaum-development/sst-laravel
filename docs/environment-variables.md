# Environment Variables

There are multiple ways to configure environment variables:

- an [environment file](#environment-file) from your project, copied into the containers as their `.env`;
- [individual variables](#variables-in-the-config) set in `sst.config.ts`;
- [SST secrets](#sst-secrets) linked to the service;
- [`RemoteEnvVault`](#aws-secrets-manager-remoteenvvault), which stores the file in AWS Secrets Manager.

On top of these, SST Laravel [adds variables](#variables-sst-laravel-adds) for linked resources and a few Laravel settings.

## Environment file

If you want SST Laravel to copy an environment file, configure the `config.environment.file` entry. The configuration below copies a file named `.env.$STAGE` (e.g. `.env.production`) into the deployment containers as your `.env` file.

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

Keep the file out of Git, and don't put AWS access keys in it. See [Troubleshooting](troubleshooting.md#cd-aws-credentials-are-not-configured).

## Variables in the config

To set individual variables in `sst.config.ts`, use `config.environment.vars`:

```js
const app = new LaravelService('MyLaravelApp', {
  // ...
  config: {
    environment: {
      vars: {
        SESSION_DRIVER: 'redis',
        QUEUE_CONNECTION: 'redis',
      }
    }
  }
});
```

## SST secrets

You can also use SST Secrets to store your environment variables. This is a more secure way to store your environment variables.

```js
const APP_KEY = new sst.Secret("APP_KEY");
const DB_PASSWORD = new sst.Secret("DB_PASSWORD");

const app = new LaravelService('MyLaravelApp', {
  link: [APP_KEY, DB_PASSWORD],
});
```

This will automatically inject the environment variables into the `.env` file of your Laravel application. Read more about [SST Secrets](https://sst.dev/docs/component/secret/).

## AWS Secrets Manager (RemoteEnvVault)

For a more robust environment variable management solution similar to Laravel Vapor, you can use the `RemoteEnvVault` component. This stores your environment variables in AWS Secrets Manager and provides CLI commands to push and pull secrets.

```js
const { RemoteEnvVault, LaravelService } = await import("@kirschbaum-development/sst-laravel");

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

The secrets are stored in AWS Secrets Manager at the path `/{app-name}/{stage}/env`. You can also use a custom path:

```js
const env = new RemoteEnvVault("Env", {
  path: "/custom/path/env"
});
```

### Pushing secrets

To push your local `.env` file to AWS Secrets Manager:

```bash
# Push .env.production to the production stage
npx sst-laravel env:push --stage production --input .env.production

# Push .env to staging (interactive)
npx sst-laravel env:push --stage staging
```

### Pulling secrets

To pull secrets from AWS Secrets Manager to a local file:

```bash
# Pull from production to .env.production (default)
npx sst-laravel env:pull --stage production

# Pull from staging to a custom file
npx sst-laravel env:pull --stage staging --output .env.local
```

### Deploying with secrets

When using `RemoteEnvVault`, deploy using the `sst-laravel deploy` command, which automatically fetches secrets before building:

```bash
npx sst-laravel deploy --stage production
```

### Workflow example

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

### Large environment files

Large environment files that exceed AWS Secrets Manager's 64KB limit are automatically handled. The CLI will:

- Split large `.env` files into multiple chunks when pushing
- Automatically merge all chunks when pulling or deploying

This is completely transparent. You don't need to do anything special.

## Variables SST Laravel adds

SST Laravel fills in some variables for you, with both environment files and `RemoteEnvVault`:

- **Linked resources.** Linking a database, Redis, or a bucket injects its `DB_*`, `REDIS_*`, or `AWS_*` variables. See [Linking Resources](linking-resources.md).
- **`LOG_CHANNEL`.** To send logs to AWS CloudWatch, `LOG_CHANNEL` must be `stderr`. If your environment doesn't set it, SST Laravel adds `LOG_CHANNEL=stderr`.
- **`APP_URL`.** If your environment doesn't set it, SST Laravel adds it with the value of the `web.domain` property.
- **Reverb.** With `reverb.domain` set, SST Laravel adds the `REVERB_*` variables. See [Reverb](reverb.md#environment-variables).

To stop SST Laravel from injecting variables for linked resources, set `config.environment.autoInject` to `false`. See [Disabling the auto-inject of environment variables](linking-resources.md#disabling-the-auto-inject-of-environment-variables).
