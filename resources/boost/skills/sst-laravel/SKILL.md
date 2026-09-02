---
name: sst-laravel
description: Set up, deploy, verify, and troubleshoot Laravel applications on AWS Fargate with the @kirschbaum-development/sst-laravel package. Use when an agent must take an application from local SST Laravel configuration through a healthy deployment.
---

# Deploy with SST Laravel

Take the current Laravel application from inspection to a working deployment. Do not stop after writing `sst.config.ts`. Continue through deployment and HTTP verification unless access or a required user decision blocks the work.

## Use the installed package as the source of truth

Read the documentation for the installed package version before you change the application:

- In an application, read `node_modules/@kirschbaum-development/sst-laravel/README.md`, `node_modules/@kirschbaum-development/sst-laravel/docs/api.md`, and the installed `package.json`.
- In the SST Laravel package repository, read `README.md`, `docs/api.md`, and `package.json`.
- Run `npx sst-laravel --help` and the relevant subcommand help before use. Do not invent options that the installed CLI does not show.

Use official SST, Laravel, and AWS documentation only when the local package documentation does not answer a version-sensitive question.

## Safety rules

- Never print, paste, or summarize secret values. You can inspect environment variable names.
- Check that each stage environment file is ignored by Git before you add secrets. Do not ignore `.env.example`.
- Do not put AWS access keys in a Laravel environment file. Use the active AWS profile, SSO session, or workload role.
- Preserve a working `sst.config.ts` and existing AWS resources. Do not replace them with the starter configuration.
- A deploy can create chargeable AWS resources. If the user asked you to deploy, that request authorizes a normal, non-destructive deployment to the agreed stage. If the user asked only for setup, get approval before the first deploy.
- Get explicit approval before you remove, replace, or import a resource in a way that can change or delete it. Check protection, retention, and backups first.
- Prefer a `dev` stage for the first deployment. Do not deploy to `production` unless the user selected it or the existing project workflow clearly requires it.

## 1. Inspect the application and AWS context

Find the Laravel root. Inspect `composer.json`, `package.json`, `.env.example`, `.gitignore`, `bootstrap/app.php`, routes, and any existing SST configuration. Detect these needs from the code and environment variable names:

- database and migrations;
- cache, session, and queue drivers;
- public file storage;
- Horizon or other queue workers;
- scheduled tasks;
- Reverb;
- mail and external services;
- a custom domain and DNS provider.

Run safe prerequisite checks. Use the project's package manager when it is clear.

```bash
php --version
node --version
npm --version
aws --version
aws sts get-caller-identity
npx sst-laravel --help
```

Also get the active AWS region from the environment, AWS config, or existing SST config. Do not change an AWS profile or region without user agreement. Ask only for information that you cannot infer and that blocks the next action.

## 2. Prepare the smallest valid first deployment

Install `@kirschbaum-development/sst-laravel` if it is missing. If no SST config exists, run:

```bash
npx sst-laravel init
```

If `init` asks to install this skill and the skill is already active, decline the duplicate installation.

The generated config demonstrates a VPC, database, workers, a domain, and `RemoteEnvVault`. For a first smoke deployment, remove placeholder resources that the application does not need yet. Keep the first config small:

- one `LaravelService`;
- `web` enabled;
- no placeholder domain;
- no workers or Reverb unless the application requires them to boot;
- no placeholder database, Redis, or bucket;
- `web.healthCheck.path` set to Laravel's available health route, normally `/up`;
- the service URL returned from `run()`.

For the first `dev` deploy, an environment file is the shortest path unless the repository already uses `RemoteEnvVault` or SST secrets:

```ts
config: {
  environment: {
    file: `.env.${$app.stage}`,
  },
},
web: {
  healthCheck: { path: "/up" },
},
```

Create `.env.dev` from `.env.example` when it does not exist. Generate an application key with `php artisan key:generate --env=dev`. Before deployment:

- set `APP_ENV=production` and `APP_DEBUG=false` for any public endpoint;
- set `LOG_CHANNEL=stderr`;
- confirm that the configured database, cache, session, queue, and filesystem drivers are valid in a container;
- do not run migrations from the generated deployment script until a persistent database exists and the user wants migrations during startup;
- confirm that the exact environment file is ignored with `git check-ignore`.

Do not replace an existing environment strategy only to follow this baseline. For a shared or CI-managed stage, prefer `RemoteEnvVault`. Use `npx sst-laravel env:push --stage <stage> --input <file>` only after you confirm the target account, region, app name, stage, and secret path. Never show the file contents.

## 3. Add only required infrastructure

After the baseline is clear, add or import resources that the application needs. Use `docs/api.md` for the exact `LaravelService` options.

- Link a database, Redis, bucket, or SST secret when SST manages it.
- Import an existing resource only after you verify its identifiers and ownership.
- Add a worker for Horizon, the scheduler, or another long-running process only when the application uses it.
- Use the first-class `reverb` option for Laravel Reverb.
- Add a domain after you know the DNS provider, certificate plan, and stage hostname.
- Configure trusted proxies with the API supported by the installed Laravel version.

Keep production protection and retention settings. Explain material cost items, such as load balancers, NAT gateways, databases, Redis, and extra ECS services, before you add them.

## 4. Validate and deploy

Run the application's relevant local checks first. Then use any read-only SST preview command only if it appears in `npx sst --help` for the installed version.

Before the deploy, report the selected AWS identity, region, stage, environment strategy, and resources without secret values. Deploy with:

```bash
npx sst-laravel deploy --stage <stage>
```

Use this command instead of direct `sst deploy` so that `RemoteEnvVault` works when configured. Keep the full error output if deployment fails.

## 5. Verify and repair

A successful infrastructure command is not enough. Get the returned web URL and request the health endpoint. Confirm all of these items:

- the deploy command exited successfully;
- the ECS web task is running and stable;
- the load balancer target is healthy;
- `GET /up`, or the configured health route, returns a successful HTTP response;
- the task does not enter a restart loop after the first request.

If verification fails, inspect the deployment error, ECS task state, load balancer target health, and recent CloudWatch logs. `npx sst-laravel logs web --stage <stage>` follows logs continuously, so stop it after you collect the useful error. Check environment names, IAM permissions, health path, container startup, database access, and migrations. Make one focused fix, redeploy, and verify again.

Do not ask the user to diagnose an error that you can inspect with the available CLI tools. Stop only when the same blocker needs credentials, a business choice, or permission for a destructive action.

## Completion report

Finish only when the application is healthy or a concrete external blocker remains. Report:

- deployed app name, stage, region, and URL;
- HTTP verification result;
- resources that were created, imported, or reused;
- environment strategy, with no secret values;
- code and config files changed;
- remaining work, such as a production domain, CI, migrations, or cost review.

After the first healthy deployment, offer production hardening or GitHub Actions as a separate next step. Do not expand the first deployment into CI work without user agreement.
