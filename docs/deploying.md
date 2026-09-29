# Deploying

## Deploy

To deploy your application, use the `sst-laravel deploy` command. You must be authenticated with AWS in your terminal session to deploy.

```bash
npx sst-laravel deploy --stage {stage}
npx sst-laravel deploy --stage sandbox
npx sst-laravel deploy --stage production
```

> **Note:** If you're using `RemoteEnvVault` for secrets management, you should use `sst-laravel deploy` instead of `sst deploy` directly. This ensures secrets are fetched from AWS Secrets Manager before the Docker build.

## Readiness and status

Before deploying, check that the machine and app are ready:

```bash
npx sst-laravel doctor
```

It checks that the package is installed, tool versions, that Docker is running, AWS login and region, Laravel drivers, trusted proxies, `sst.config.ts`, and that stage env files are ignored by git. It never prints secret values.

After deploying, check everything in one view (running tasks plus the `/up` health endpoint):

```bash
npx sst-laravel status --stage production --url https://app.example.com
```

## PHP version and OPcache

The containers run PHP 8.4 unless you set `config.php`. The available versions are 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, and 8.5. Set `config.opcache` to `true` to enable OPcache:

```js
const app = new LaravelService('MyLaravelApp', {
  config: {
    php: 8.4,
    opcache: true,
  },
});
```

## Deployment script

A deployment script runs each time a container starts. Use it for migrations, caching, and similar steps:

```js
const app = new LaravelService('MyLaravelApp', {
  config: {
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

Only run migrations once the stage has a persistent database. Otherwise, they have nowhere to run and the containers fail to start.

## Deploying from GitHub Actions

`sst-laravel github-iam` creates an IAM role that GitHub Actions can assume through OIDC, so your workflow deploys without stored AWS keys:

```bash
npx sst-laravel github-iam --branch main
```

It creates the GitHub OIDC provider in your AWS account if it's missing, creates the role, and prints the workflow steps to add. The role trusts only your repository (detected from the git remote, or set with `--repo`) and the branch you pass (all branches by default). It gets the `AdministratorAccess` policy, so restrict the branch to the ones that should deploy. See the [CLI reference](cli.md#github-iam) for all options.

If you use `RemoteEnvVault`, change the printed `npx sst deploy` step to `npx sst-laravel deploy`.
