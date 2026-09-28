# SST Laravel

![](https://github.com/kirschbaum-development/sst-laravel/raw/main/images/deploy.png)

SST Laravel is an unofficial extension of [SST](https://sst.dev) created by [Kirschbaum Development](https://kirschbaumdevelopment.com) to deploy your Laravel application to AWS behind a robust, reliable and scalable infrastructure, with all the power of SST.

SST is a framework that makes it easy to build modern full-stack applications on your own infrastructure.

## What gets deployed

Behind the scenes, this extension uses the SST Cluster + Service component, which deploys custom Docker containers to AWS Fargate. It all gets deployed on your own AWS account, and you have full control over the infrastructure and which services are connected to your application.

This package deploys a full-blown infrastructure in AWS, with zero downtime deployments, as you can see in the image below.

Behind the scenes, we use the powerful PHP containers from [Serverside Up](https://serversideup.net/open-source/docker-php/).

![](https://github.com/kirschbaum-development/sst-laravel/raw/main/images/diagram.png)

## Quick start

In your Laravel application:

```bash
npm install @kirschbaum-development/sst-laravel --save
npx sst-laravel init
npx sst-laravel deploy --stage dev
```

`init` creates a minimal `sst.config.ts`: a VPC and one small web container that reads its environment from `.env.<stage>`. Before the first deploy, create `.env.dev` and trust the load balancer in your app. [Getting Started](docs/getting-started.md) walks through each step.

From there, add what your application needs:

```ts
const app = new LaravelService("MyLaravelApp", {
  vpc,
  link: [database, redis],
  web: {
    size: "medium",
    domain: "app.example.com",
    healthCheck: { path: "/up" },
    scaling: { min: 1, max: 3 },
  },
  workers: [{ name: "horizon", horizon: true }],
  reverb: { domain: "ws.example.com" },
  config: {
    environment: { file: `.env.${$app.stage}` },
  },
});
```

## Deploy with an AI agent

Start in your Laravel application and paste this into your coding agent:

```text
Fetch and follow the instructions at https://raw.githubusercontent.com/kirschbaum-development/sst-laravel/main/docs/agent-setup.md to set up and deploy this Laravel app with SST Laravel.
```

The agent installs the package and the [SST Laravel skill](resources/boost/skills/sst-laravel/SKILL.md), checks your machine and AWS access, and prepares the smallest working configuration. Before the first deploy, it shows you what will be created and the monthly cost, and waits for your yes. Then it deploys a `dev` stage and checks the live `/up` endpoint. It never prints secret values.

To install or update only the skill:

```bash
npx sst-laravel skill:install
```

With [Laravel Boost](https://laravel.com/docs/boost) set up, this adds the skill to `.ai/skills` and runs `php artisan boost:update`. Otherwise it uses the [skills CLI](https://github.com/vercel-labs/skills).

## Documentation

Read the full documentation at [docs.kirschbaumdevelopment.com](https://docs.kirschbaumdevelopment.com/projects/sst-laravel/). The same pages live in [`docs/`](docs/README.md) and ship with the npm package:

| Page | What it covers |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Requirements, installation, the generated `sst.config.ts`, the first deploy, and checking it. |
| [Web](docs/web.md) | The HTTP service: domain, container size, scaling, health check, HTTPS redirect, and access logs. |
| [Workers](docs/workers.md) | Horizon, the scheduler, and custom commands in worker containers or in the web container. |
| [Reverb](docs/reverb.md) | A dedicated Laravel Reverb service for WebSockets, with its own domain. |
| [Environment Variables](docs/environment-variables.md) | Environment files, SST secrets, `RemoteEnvVault` (AWS Secrets Manager), and the variables SST Laravel adds. |
| [Linking Resources](docs/linking-resources.md) | Linked databases, Redis, and buckets, PlanetScale, custom variable names, and IAM permissions. |
| [Deploying](docs/deploying.md) | The `deploy` command, readiness and status checks, PHP settings, the deployment script, and GitHub Actions. |
| [CLI](docs/cli.md) | Every `sst-laravel` command and its options. |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and how to fix them. |
| [API Reference](docs/api.md) | Every `LaravelService` and `RemoteEnvVault` option. |

## Requirements

- Node.js.
- SST 4.17.1 or later within version 4. The `init` command installs SST if it is missing.
- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), installed and configured. See the SST guide on [setting up IAM credentials](https://sst.dev/docs/iam-credentials/).

## Roadmap

* Ability to extend base Docker images;
* Add support for Inertia SSR;
* Add support for Octane with FrankenPHP;
* Dev mode;
* ...what else are we missing?

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Security

If you discover any security related issues, please email security@kirschbaumdevelopment.com instead of using the issue tracker.

## Sponsorship

Development of this package is sponsored by Kirschbaum Development Group, a developer driven company focused on problem solving, team building, and community. Learn more [about us](https://kirschbaumdevelopment.com) or [join us](https://careers.kirschbaumdevelopment.com)!

## License

The MIT License (MIT). Please see [License File](LICENSE.md) for more information.
