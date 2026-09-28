# SST Laravel Documentation

SST Laravel deploys a Laravel application to AWS Fargate with [SST](https://sst.dev). You describe the application in `sst.config.ts` with the `LaravelService` component: a web service, optional workers and Reverb, the environment, and the AWS resources it links to. SST Laravel builds the Docker images and deploys them to your own AWS account.

## Start here

If you are new to the package, read the pages in this order:

1. [Getting Started](getting-started.md) installs the package, creates `sst.config.ts`, and deploys a `dev` stage.
2. [Environment Variables](environment-variables.md) shows how the containers get their `.env`.
3. [Linking Resources](linking-resources.md) connects a database, Redis, or a bucket.

Everything else can be read as you need it.

## Pages

| Page | What it covers |
| --- | --- |
| [Getting Started](getting-started.md) | Requirements, installation, the generated `sst.config.ts`, the first deploy, and checking it. |
| [Web](web.md) | The HTTP service: domain, container size, scaling, health check, HTTPS redirect, and access logs. |
| [Workers](workers.md) | Horizon, the scheduler, and custom commands in worker containers or in the web container. |
| [Reverb](reverb.md) | A dedicated Laravel Reverb service for WebSockets, with its own domain. |
| [Environment Variables](environment-variables.md) | Environment files, SST secrets, `RemoteEnvVault` (AWS Secrets Manager), and the variables SST Laravel adds. |
| [Linking Resources](linking-resources.md) | Linked databases, Redis, and buckets, PlanetScale, custom variable names, and IAM permissions. |
| [Deploying](deploying.md) | The `deploy` command, readiness and status checks, PHP settings, the deployment script, and GitHub Actions. |
| [CLI](cli.md) | Every `sst-laravel` command and its options. |
| [Troubleshooting](troubleshooting.md) | Common errors and how to fix them. |
| [API Reference](api.md) | Every `LaravelService` and `RemoteEnvVault` option. |
| [Agent Setup](agent-setup.md) | The instructions a coding agent follows to set up and deploy an app. |

## Conventions

The examples show only the `LaravelService` call. It goes inside the `run()` function of `sst.config.ts`, with the component imported the same way `init` does it:

```ts
const { LaravelService } = await import("@kirschbaum-development/sst-laravel");
```

`$app.stage` is the SST stage you deploy, such as `dev` or `production`.
