---
name: sst-laravel
description: Set up, deploy, verify, and troubleshoot Laravel applications on AWS with the @kirschbaum-development/sst-laravel package. Use when an agent must take an application from local configuration through a healthy deployment.
---

# Deploy with SST Laravel

Take the current Laravel application from inspection to a working deployment. Do not stop after writing `sst.config.ts`. Continue through deployment and health verification unless access or a required user decision blocks the work.

## Start with optional onboarding

Do not start with a request for permission to create files or deploy. When the user asks for the full setup and deployment, first ask:

> Before I start, would you like a short overview of what gets deployed and what it costs, or should I begin the setup now?

Offer two clear choices: `Show overview` and `Start setup`.

If the user requests the overview, explain these points in plain words:

- SST Laravel packs the app into a container (a sealed box with PHP, nginx, and the app code) and runs it on AWS for you, in your own AWS account.
- A normal setup creates: a private network (VPC), a load balancer (the front door that sends web traffic to the box), the running container itself, and logs you can read.
- The package also supports background workers (queues, scheduler, Horizon), WebSockets (Reverb), custom domains, stages (dev, production), and scaling.
- Good parts: you own the infrastructure, deploys repeat the same way every time, the box is isolated, and updates happen without downtime.
- Costs and trade-offs: you pay while things run — roughly $12/month for a small container, $16/month for the load balancer, $0.50/month for the network. A database or extra services add more. Builds take a few minutes.

Keep the overview short. After it, continue with the inspection below unless the user asks you to stop.

If the user selects `Start setup`, continue immediately. The initial request already authorizes expected project files and a normal, non-destructive deployment to the agreed stage. Do not ask for the same permission again. Still explain the planned AWS identity, region, stage, resources, and monthly cost before deploying. Follow the safety rules below for production, destructive actions, and unexpected costly resources.

## Use the installed package as the source of truth

Read the documentation for the installed package version before you change the application:

- In an application, read `docs/llms.txt` first (short), then `docs/api.md` only for the options you need, plus the installed `package.json` version.
- In the SST Laravel package repository, read `docs/llms.txt`, `README.md`, `docs/api.md`, and `package.json`.
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

Then run the readiness check — it covers tools, AWS login, region, drivers, trusted proxies, and git-ignored secrets in one go:

```bash
npx sst-laravel doctor
```

Fix anything marked `FIX` before continuing. Do not change an AWS profile or region without user agreement. Ask only for information that you cannot infer and that blocks the next action.

## 2. Prepare the smallest valid first deployment

Install `@kirschbaum-development/sst-laravel` if it is missing. If no SST config exists, run:

```bash
npx sst-laravel init
```

If `init` asks to install this skill and the skill is already active, decline the duplicate installation.

`init` generates a minimal config on purpose: one `LaravelService`, web only, no domain, no database, health check at `/up`. Keep it that way for the first deploy. For the first `dev` deploy, an environment file is the shortest path unless the repository already uses `RemoteEnvVault` or SST secrets:

```ts
config: {
  environment: {
    file: `.env.${$app.stage}`,
  },
},
web: {
  size: "small",
  healthCheck: { path: "/up" },
},
```

Create `.env.dev` from `.env.example` when it does not exist. Generate an application key with `php artisan key:generate --env=dev`. Before deployment:

- set `APP_ENV=production` and `APP_DEBUG=false` for any public endpoint;
- set `LOG_CHANNEL=stderr`;
- confirm that the configured database, cache, session, queue, and filesystem drivers are valid in a container (sqlite/files work without extra resources; mysql/pgsql/redis/s3 need linked resources);
- keep the deployment script disabled until a persistent database exists and the user wants migrations at startup;
- confirm that the exact environment file is ignored with `git check-ignore`.

Do not replace an existing environment strategy only to follow this baseline. For a shared or CI-managed stage, prefer `RemoteEnvVault`. Use `npx sst-laravel env:push --stage <stage> --input <file>` only after you confirm the target account, region, app name, stage, and secret path. Never show the file contents.

## 3. Add only required infrastructure

After the baseline is clear, add or import resources that the application needs. Use `docs/llms.txt` and `docs/api.md` for the exact `LaravelService` options.

- The default VPC has no NAT gateway (cheapest). Only add `nat: "ec2"` to the VPC when private resources need internet access. Avoid `nat: "managed"` unless scale demands it.
- Link a database, Redis, bucket, or SST secret when SST manages it.
- Import an existing resource only after you verify its identifiers and ownership.
- Add a worker for Horizon, the scheduler, or another long-running process only when the application uses it.
- Use the first-class `reverb` option for Laravel Reverb.
- Add a domain after you know the DNS provider, certificate plan, and stage hostname.
- Configure trusted proxies with the API supported by the installed Laravel version.

Keep production protection and retention settings. Explain material cost items, such as load balancers, NAT gateways, databases, Redis, and extra container services, before you add them.

## 4. Validate and deploy

Run the application's relevant local checks first. Then use any read-only SST preview command only if it appears in `npx sst --help` for the installed version.

Before the deploy, report the selected AWS identity, region, stage, environment strategy, and resources without secret values. Deploy with:

```bash
npx sst-laravel deploy --stage <stage>
```

Use this command instead of direct `sst deploy` so that `RemoteEnvVault` works when configured. Keep the full error output if deployment fails.

## 5. Verify and repair

A successful infrastructure command is not enough. Check tasks and the health endpoint together:

```bash
npx sst-laravel status --stage <stage> --url <app-url-from-deploy-output>
```

Confirm all of these items:

- the deploy command exited successfully;
- at least one web task is running and stable;
- `GET /up`, or the configured health route, returns a successful HTTP response;
- the task does not enter a restart loop after the first request.

If verification fails, the usual causes in order are:

1. missing or wrong `APP_KEY`;
2. trusted proxies not configured, so the app builds `http` URLs behind the `https` load balancer;
3. database unreachable (wrong host, missing link, or migrations never ran);
4. wrong health path (Laravel ships `/up` on recent versions — confirm the route exists);
5. AWS keys committed in the env file (remove them and rely on the container role instead).

Read recent errors with `npx sst-laravel logs web --stage <stage>` (it follows logs continuously, so stop it after you collect the useful error). Make one focused fix, redeploy, and verify again.

Do not ask the user to diagnose an error that you can inspect with the available CLI tools. Stop only when the same blocker needs credentials, a business choice, or permission for a destructive action.

## Completion report

Finish only when the application is healthy or a concrete external blocker remains. Report:

- deployed app name, stage, region, and URL;
- health verification result;
- resources that were created, imported, or reused;
- environment strategy, with no secret values;
- code and config files changed;
- remaining work, such as a production domain, CI, migrations, or cost review.

After the first healthy deployment, offer production hardening or GitHub Actions as a separate next step. Do not expand the first deployment into CI work without user agreement.
