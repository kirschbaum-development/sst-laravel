# Getting Started

This guide takes a Laravel application to a running `dev` stage on AWS. To let a coding agent do it for you, see [Deploy with an AI agent](../README.md#deploy-with-an-ai-agent).

## Requirements

1. Node.js.
1. SST 4.17.1 or later within version 4. The `init` command installs SST if it is missing.
1. The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), installed and configured. See the SST guide on [setting up IAM credentials](https://sst.dev/docs/iam-credentials/).

## Install the package

In your Laravel application, pull in the package using npm:

```bash
npm install @kirschbaum-development/sst-laravel --save
```

Install it before any `npx sst-laravel` command. Until it is installed, `npx` looks for a different, unscoped package with that name.

## Create the SST config

```bash
npx sst-laravel init
```

`init` creates `sst.config.ts` with the smallest working setup: a VPC and one small web container that reads its environment from `.env.<stage>`. The command also offers to install the bundled `sst-laravel` skill for later agent sessions. It uses Laravel Boost when available. Otherwise, it uses the open `skills` installer.

The generated configuration comes down to this:

```ts
const { LaravelService } = await import("@kirschbaum-development/sst-laravel");

const vpc = new sst.aws.Vpc("MyVpc");

const app = new LaravelService("MyLaravelApp", {
  vpc,
  config: {
    php: 8.4,
    environment: {
      file: `.env.${$app.stage}`,
    },
  },
  web: {
    size: "small",
    healthCheck: { path: "/up" },
  },
});

return {
  url: app.url,
};
```

The generated file keeps commented-out examples for a domain, a database, workers, and Reverb. All the configuration options are TypeScript types with documentation, so your editor shows them as you type. The [API reference](api.md) lists every option.

### The VPC

Fargate containers only run inside a VPC. `new sst.aws.Vpc("MyVpc")` with no options is the cheapest (about $0.50/month). Without a NAT gateway, containers run in the public subnets with a public IP (about $3.65/month each); inbound traffic still only comes through the load balancer.

Add `nat: "ec2"` (about $13/month) to keep containers in private subnets, for example when a third party needs a fixed outbound IP. Avoid `nat: "managed"` (about $73/month) unless you need the scale.

To reuse an existing VPC instead of creating one:

```ts
const vpc = sst.aws.Vpc.get("MyVpc", "vpc-12345678901234567");
```

## Create the environment file

The configuration above copies `.env.dev` into the containers as their `.env` when you deploy the `dev` stage. Copy `.env.example` to `.env.dev` and check that:

- `APP_KEY` is set and `APP_DEBUG` is `false`;
- the file is ignored by Git (`git check-ignore .env.dev`);
- it contains no AWS access keys. The containers get their AWS permissions from an IAM role.

SST Laravel adds `LOG_CHANNEL=stderr` when the file doesn't set it, and `APP_URL` once you configure a domain. For other ways to manage variables, such as AWS Secrets Manager, see [Environment Variables](environment-variables.md).

## Trust the load balancer

SST Laravel puts the containers behind a load balancer, so Laravel must trust it as a proxy. Otherwise, it generates `http://` URLs for assets and redirects. Configure the trusted proxies in `bootstrap/app.php`:

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '*');
})
```

## Check that you're ready

```bash
npx sst-laravel doctor
```

It checks that the package is installed, tool versions, AWS login and region, Laravel drivers, trusted proxies, `sst.config.ts`, and that stage env files are ignored by git. It never prints secret values.

## Deploy

You must be authenticated with AWS in your terminal session to deploy.

```bash
npx sst-laravel deploy --stage dev
```

When it finishes, the deploy prints the app URL. Without a domain, this is the load balancer address (http only).

## Check the deployment

Check the running tasks and Laravel's `/up` health endpoint in one view:

```bash
npx sst-laravel status --stage dev --url <url-from-deploy>
```

## Next steps

- Add a domain, a bigger container, or auto-scaling: [Web](web.md).
- Run queues and the scheduler: [Workers](workers.md).
- Only accept traffic from your CDN or WAF, or keep the load balancer access logs: [Load Balancer](load-balancer.md).
- Add a database, Redis, or a bucket: [Linking Resources](linking-resources.md).
- Run migrations on each deploy: [Deploying](deploying.md#deployment-script).
