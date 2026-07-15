# Laravel on Cloudflare Containers

This demo deploys a Laravel 13 application with the experimental Cloudflare provider from the `feat/cloudflare-containers-prototype` branch of `sst-laravel`.

By default, SST creates and links:

- a Cloudflare D1 database through `erimeilis/laravel-cloudflare-d1`;
- the standard Laravel database cache store backed by D1;
- Laravel authentication with users and sessions stored in D1.

R2 remains available as an opt-in integration through Laravel's S3 filesystem driver. The demo uses local SST state so an account can deploy the Container and D1 before enabling R2.

The `/up` route is used for container health checks. After running the database migrations, use `/register`, `/login`, and `/dashboard` to exercise user and session persistence. The `/cloudflare` route performs a live database query and a temporary cache write. When R2 is enabled, it also performs a temporary R2 write/read/delete operation.

## Prerequisites

- PHP 8.2 or newer and Composer
- Node.js and npm
- Docker running locally
- a Cloudflare account on the Workers Paid plan (required for Containers)

## Install

From this directory:

```bash
composer install
npm install
npm run sst:install
```

The NPM dependency points directly at the prototype branch:

```json
"@kirschbaum-development/sst-laravel": "git+https://github.com/kirschbaum-development/sst-laravel.git#feat/cloudflare-containers-prototype"
```

## Configure credentials

SST and Wrangler use these shell environment variables to provision and deploy infrastructure:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_DEFAULT_ACCOUNT_ID="..."
```

The deployment token needs access to Workers Scripts, Containers, and D1. It also needs R2 access when the optional bucket is enabled. SST state for this demo is stored locally.

Laravel uses narrower runtime credentials. Edit the gitignored `.env.cloudflare` file:

```dotenv
APP_KEY=base64:...
CLOUDFLARE_D1_API_TOKEN=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Generate the application key with `php artisan key:generate --show`. The D1 token needs the account-level `D1 Edit` permission because registration, sessions, and cache entries all write to the database. If you enable R2, generate the R2 Access Key ID and Secret Access Key from an R2 API token with Object Read & Write access.

The D1 account/database IDs and, when enabled, the R2 bucket/endpoint/region are injected automatically from the linked SST resources. Do not add them to `.env.cloudflare`.

## Deploy

```bash
npm run deploy -- --stage dev
```

To also provision and link R2 after enabling it for your Cloudflare account:

```bash
SST_LARAVEL_ENABLE_R2=true npm run deploy -- --stage dev
```

The first deployment prints `url` and `databaseId`; R2-enabled deployments also print `bucketName`. Apply migrations before testing browser routes because Laravel uses the D1-backed database session driver.

Apply Laravel's migrations to D1 using the printed database ID:

```bash
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_DEFAULT_ACCOUNT_ID" \
CLOUDFLARE_D1_DATABASE_ID="<databaseId from SST>" \
CLOUDFLARE_D1_API_TOKEN="<D1 runtime token>" \
DB_CONNECTION=d1 \
php artisan migrate --database=d1 --force
```

Then open `<url>/cloudflare`. A healthy response looks like:

```json
{
  "database": true,
  "cache": true,
  "storage": true,
  "filesystem": "local"
}
```

With R2 enabled, `filesystem` is `s3` instead.

To preview infrastructure changes or remove the development stage:

```bash
npm run sst:diff -- --stage dev
npm run remove -- --stage dev
```

The production stage is protected and retains its D1 database and R2 bucket by default.
