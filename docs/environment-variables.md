# Environment Variables

There are multiple ways to configure environment variables:

- an [environment file](#environment-file) from your project, which becomes the containers' environment;
- [individual variables](#variables-in-the-config) set in `sst.config.ts`;
- [SST secrets](#sst-secrets) linked to the service;
- [`RemoteEnvVault`](#aws-secrets-manager-remoteenvvault), which stores the file in AWS Secrets Manager.

On top of these, SST Laravel [adds variables](#variables-sst-laravel-adds) for linked resources and a few Laravel settings. The containers get all of them [from S3 when they start](#how-the-containers-get-the-variables), so no secret is stored in the container image.

## Which one to use

- **An environment file** is the simplest and costs nothing, but only a machine that has the file can deploy. It suits one person, or trying SST Laravel out.
- **`RemoteEnvVault`** keeps the file in your AWS account (about $0.40/month per stage), so teammates and CI deploy with the same values without passing a file around. It suits teams, CI, and production.
- **Your own store**, such as S3, 1Password, or a GitHub Actions secret, keeps the values where your team already has them. A step before each deploy writes them to the environment file. See [Environment File Sources](environment-file-sources.md).
- **SST secrets** keep the most sensitive values out of your environment file. SST Laravel adds them to the environment that the environment file or `RemoteEnvVault` provides, so use them with one of the two.
- **Variables in the config** are committed with the code, so use them only for values that aren't secret.

## Environment file

If you want SST Laravel to use an environment file, configure the `config.environment.file` entry. The configuration below uses a file named `.env.$STAGE` (e.g. `.env.production`) as the containers' environment.

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

The deploy reads the file when it starts, so the file can come from anywhere: S3, 1Password, a GitHub Actions secret, or another tool your team uses. Fetch it in a step before the deploy. [Environment File Sources](environment-file-sources.md) shows how, on your machine and in CI.

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

This will automatically add them to the environment of your Laravel application. Read more about [SST Secrets](https://sst.dev/docs/component/secret/).

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
  path: `/custom/${$app.stage}/env`
});
```

`env:push` and `env:pull` read the path from `sst.config.ts`, filling in `$app.name` and `$app.stage`. When the path is built some other way, pass it with `--path`.

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

SST Laravel adds them after your variables. Laravel reads the last value of a variable, so the values of linked resources win over the same variables in your environment, such as `DB_CONNECTION=sqlite` copied from `.env.example`. `LOG_CHANNEL` and `APP_URL` are only added when your environment doesn't set them.

To stop SST Laravel from injecting variables for linked resources, set `config.environment.autoInject` to `false`. See [Disabling the auto-inject of environment variables](linking-resources.md#disabling-the-auto-inject-of-environment-variables).

## How the containers get the variables

The deploy reads your environment file or `RemoteEnvVault`, adds the variables above, and uploads the result to a private S3 bucket that SST Laravel creates for each component. When a container starts, ECS reads the file and sets the variables, and the container writes them to the app's `.env` too, so `php artisan` commands and code that reads the file work as before. Nothing secret is stored in the container image.

- **Only the services can read the bucket.** Its policy denies reading the files to everyone except the services' ECS execution roles, even users with broad read permissions such as `ReadOnlyAccess`. Public access is blocked and plain HTTP is refused.
- **Each change gets a new file.** A new environment gives the services a new task definition, so ECS rolls them out, and a rollback gets the environment it was deployed with. A file is kept for 30 days after a deploy replaces it; later deploys delete the older ones.
- **Values that span lines**, such as a Passport private key, go to a Secrets Manager secret instead (`/{app-name}/{stage}/sst-laravel/{component}/multiline-env/...`), since an ECS environment file can't hold them. It costs about $0.40 a month, and only exists when you have such values.
- **Empty values** reach the app's `.env`, as `KEY=`. ECS doesn't set variables with empty values from a file, so the app only sees them through the `.env`, the way Laravel read them before.
- **`${VAR}` references are filled in** the way Laravel fills them in, from the variables in `config.environment.vars` and from earlier lines. A reference to a variable only the container has, such as `${HOSTNAME}` or the image's `${PHP_MEMORY_LIMIT}`, is kept as written, since the deploy can't know its value. Set the value in full, or set the variable in `config.environment.vars`.
- **Variables the container image sets**, such as `PHP_MEMORY_LIMIT`, `SSL_MODE`, `NGINX_*`, or `AUTORUN_*`, are left out, with a warning in the deploy output. Laravel never let the `.env` override them. To change them, set them in `config.environment.vars`.

Execution roles that you bring with `advanced.executionRole` get a policy attached that lets them read the bucket. With a deploy role of your own, it needs to create, describe, and restore the secret, create the bucket and the IAM policy, and upload, tag, list, and delete files in the bucket.

### Encrypting with your own KMS key

Set `config.environment.kms` to `true` to encrypt the environment with a customer-managed KMS key that only the services can decrypt. Even someone who can read the bucket or the secret can't read the values, and CloudTrail logs every decryption. The key costs about $1 a month.

```js
const app = new LaravelService('MyLaravelApp', {
  // ...
  config: {
    environment: {
      secrets: env,
      kms: true,
    }
  }
});
```

### Keeping the environment in the image

Versions before 0.8 copied the environment into the container image as its `.env`, where anyone who can pull the image can read it. To keep doing that for now, set `config.environment.inImage` to `true`. The option will be removed in a future version.

Images built by those versions still contain the environment. After upgrading, rotate the secrets that were in it, and delete the old images from ECR when you no longer need to roll back to them.
