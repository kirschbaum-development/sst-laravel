# Why SST Laravel

SST Laravel runs your Laravel app in containers on AWS, in your own AWS account. This page explains what that gives you.

## What SST is

[SST](https://sst.dev) is an open-source framework for running apps in your own cloud account. You describe the infrastructure in TypeScript, in `sst.config.ts`, and SST creates, updates, and removes it for you. This is called infrastructure as code.

SST Laravel adds a `LaravelService` component to SST. It packages your app into a container (PHP, nginx, and your code) and runs it on AWS Fargate behind a load balancer.

## What you get

- **Your own AWS account.** The app, its data, and its logs stay in your account. You pay AWS directly, and you can see and change everything.
- **Everything in code.** The whole setup is one file in your repository. Changes go through pull requests, and SST applies the same config every time. A second copy of the app, such as `staging`, is the same config deployed to another stage.
- **Auto-scaling.** Set a minimum and a maximum number of containers. AWS adds containers when they get busy and removes them when traffic drops. See [Web](web.md).
- **Safe deploys.** New containers must pass the health check before the old ones stop, so deploys don't take the app down. A deploy that fails rolls back on its own.
- **Background work and WebSockets.** Queues, Horizon, the scheduler, and Reverb run in the same setup. See [Workers](workers.md) and [Reverb](reverb.md).

## Connect any AWS resource

A database, Redis, a file bucket, a queue, or email takes a few lines in `sst.config.ts`. Link it to the app, and SST Laravel fills in the Laravel variables (`DB_*`, `REDIS_*`, `AWS_*`) and gives the containers permission to use it. See [Linking Resources](linking-resources.md).

SST has ready-made [components](https://sst.dev/docs/) for common AWS services, and it works with more than 150 Pulumi and Terraform providers, such as Cloudflare and PlanetScale. When you need something the package doesn't cover, add any AWS resource yourself, or change the ones it creates with the `advanced` options. See the [API Reference](api.md).

## Security

- **No long-lived AWS keys.** The containers get short-lived credentials from an IAM role, so there are no AWS keys in your `.env` or your code. A linked resource only adds the permissions for that resource.
- **CI without stored keys.** GitHub Actions can deploy through an IAM role it assumes with OIDC. See [Deploying](deploying.md#deploying-from-github-actions).
- **Secrets out of git.** Keep the environment in AWS Secrets Manager with `RemoteEnvVault`, or in SST secrets. See [Environment Variables](environment-variables.md).
- **A closed network.** Traffic only reaches the containers through the load balancer. Databases and Redis sit in private subnets that the internet can't reach.
- **A hardened load balancer.** TLS 1.2 or later, only the listener ports open, and invalid headers dropped. See [Load Balancer](load-balancer.md).

## Good to know

- The containers and the load balancer run all the time, so they cost money even without traffic: about $46/month for the smallest web-only setup in us-east-1.
- You need an AWS account, and Docker on the machine that deploys. The first deploy takes several minutes.
