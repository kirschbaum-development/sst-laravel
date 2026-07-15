# Laravel on Cloudflare Containers

This demo deploys a Laravel 13 application with the experimental Cloudflare provider from the `feat/cloudflare-containers-prototype` branch of `sst-laravel`.

SST creates and links:

- a Cloudflare D1 database through `erimeilis/laravel-cloudflare-d1`;
- the standard Laravel database cache store backed by D1; and
- a Cloudflare R2 bucket through Laravel's S3 filesystem driver.

The `/up` route is used for container health checks. After running the database migrations, `/cloudflare` performs a live database query, a temporary cache write, and a temporary R2 write/read/delete operation.

## Prerequisites

- PHP 8.2 or newer and Composer
- Node.js and npm
- Docker running locally
- a Cloudflare account with Containers enabled

## Install

From this directory:

```bash
composer install
npm install
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

The deployment token needs access to Workers/Containers, D1, R2, and the Cloudflare state storage SST creates.

Laravel uses narrower runtime credentials. Edit the gitignored `.env.cloudflare` file:

```dotenv
APP_KEY=base64:...
CLOUDFLARE_D1_API_TOKEN=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Generate the application key with `php artisan key:generate --show`. The D1 token needs permission to query the created database. Generate the R2 Access Key ID and Secret Access Key from an R2 API token with Object Read & Write access.

The D1 account/database IDs and the R2 bucket/endpoint/region are injected automatically from the linked SST resources. Do not add them to `.env.cloudflare`.

## Deploy

```bash
npm run deploy -- --stage dev
```

The first deployment prints `url`, `databaseId`, and `bucketName`. The health endpoint can boot before migrations because sessions use encrypted cookies.

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
  "filesystem": "s3"
}
```

To preview infrastructure changes or remove the development stage:

```bash
npm run sst:diff -- --stage dev
npm run remove -- --stage dev
```

The production stage is protected and retains its D1 database and R2 bucket by default.
