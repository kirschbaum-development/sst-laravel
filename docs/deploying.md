# Deploying

## What goes into the image

The deploy builds a Docker image of your project folder on your machine and uploads it to a private registry (ECR) in your AWS account. The Dockerfile copies the folder as it is: it doesn't run `composer install` or `npm run build`. Before you deploy:

```bash
composer install
npm run build
```

`vendor/` comes from your machine, dev packages included, and needs the PHP version it was installed with (`config.php`, which `init` sets to your local version). To ship a smaller image, build in CI with `composer install --no-dev --optimize-autoloader` (see [Deploying from GitHub Actions](#deploying-from-github-actions)).

The first deploy writes a `.dockerignore` when the project has none, so the image skips `.git`, `node_modules`, every `.env*` file (the containers get their own `.env`), local SQLite databases, uploads in `storage/app`, logs, and tests. Review it and commit it. Remove `node_modules` from it if the app needs it at runtime, for example for Inertia SSR. An existing `.dockerignore` is kept as it is; only the `.sst` lines are added.

## Deploy

To deploy your application, use the `sst-laravel deploy` command. You must be authenticated with AWS in your terminal session to deploy. With several named profiles, export `AWS_PROFILE=<name>` first.

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

It checks the tools (including a reachable Docker daemon), the AWS login and region, the app and its dependencies and built assets, `sst.config.ts`, the stage env file, trusted proxies, and that git ignores the env files. It never prints secret values. See [`doctor`](cli.md#doctor) for the full list.

After deploying, check everything in one view (running tasks plus the `/up` health endpoint). The deploy returns before the new tasks pass the health check, so use `--wait` to keep checking:

```bash
npx sst-laravel status --stage production --url https://app.example.com --wait
```

`/up` doesn't touch the database. To check the database and the migrations:

```bash
npx sst-laravel command:run migrate:status --stage production
```

Without a domain, the app URL is the load balancer address and serves `http://` only. `https://` times out until you add a domain.

## Removing a stage

```bash
npx sst remove --stage dev
```

It deletes everything SST created for the stage. With the config from `init`, a database and its data go too, except on `production`, where `removal: "retain"` keeps them. See the [SST docs](https://sst.dev/docs/reference/cli/#remove).

## PHP version and OPcache

The containers run PHP 8.4 unless you set `config.php`. The available versions are 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, and 8.5. OPcache is on in every container. Set `config.opcache` to `false` to turn it off:

```js
const app = new LaravelService('MyLaravelApp', {
  config: {
    php: 8.4,
    opcache: false,
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
