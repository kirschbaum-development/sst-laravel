# Getting Started

This guide takes a Laravel application to a running `dev` stage on AWS. To let a coding agent do it for you, see [Onboard your agent](overview.md#onboard-your-agent).

## Requirements

1. Node.js.
1. SST 4.17.1 or later within version 4. The `init` command installs SST if it is missing.
1. The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), installed and signed in to your AWS account. See [AWS access](#aws-access).
1. [Docker](https://docs.docker.com/get-docker/), running. The deploy builds the container image on your machine.

## AWS access

The commands use the AWS CLI's login. If you don't have one yet, use IAM Identity Center (AWS SSO): you sign in through the browser, and no long-lived keys are stored on your machine.

1. In the AWS console, enable **IAM Identity Center**, create a user, and give it access to the account with a permission set. The first deploy creates a VPC, IAM roles, ECS, a load balancer, an image registry, and logs, so it needs broad rights: `AdministratorAccess` is the simplest in a dev or sandbox account. For a company account, SST lists a narrower policy under [IAM permissions](https://sst.dev/docs/iam-credentials/#iam-permissions).
1. Create a profile. The command asks for the start URL and region of IAM Identity Center, opens the browser, and saves the profile under a name you choose:

   ```bash
   aws configure sso
   ```

1. Use the profile for every command, and sign in again when the session expires:

   ```bash
   export AWS_PROFILE=<name>
   aws sso login --profile <name>
   ```

SST's [AWS accounts guide](https://sst.dev/docs/aws-accounts/) covers the setup in more detail. If you use access keys for an IAM user instead, set them with `aws configure`, and don't use the root user's keys. `npx sst-laravel doctor` shows the account, identity, and region in use.

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

`init` creates `sst.config.ts` with the smallest working setup: a VPC and one small web container that reads its environment from `.env.<stage>`. The app name comes from `composer.json` or the folder name, and the PHP version from your machine. It adds `.sst` to `.gitignore`. The command also offers to install the bundled `sst-laravel` skill for later agent sessions, with Laravel Boost when it's set up, otherwise in `.agents/skills` and your agent's folder.

Keep the app name unique within your AWS account: SST keys its state by app name and stage, so two projects with the same name deploying the same stage would overwrite each other.

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
  deployment: app.deployment,
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

## Build the app

The image copies your project folder as it is, so install the dependencies and build the assets first:

```bash
composer install
npm run build
```

See [What goes into the image](deploying.md#what-goes-into-the-image) for what the image includes and leaves out.

## Check that you're ready

```bash
npx sst-laravel doctor
```

It checks the tools (including a reachable Docker daemon), the AWS login and region, the dependencies and built assets, `sst.config.ts`, the stage env file, trusted proxies, and that git ignores the env files. It never prints secret values. Fix what it marks `FIX`, then run it again.

## Deploy

You must be authenticated with AWS in your terminal session to deploy. With several named profiles, export `AWS_PROFILE=<name>` so every command uses the same one.

```bash
npx sst-laravel deploy --stage dev
```

The first deploy takes several minutes: it builds the image, uploads it, and creates the resources. Then it waits until ECS runs the new tasks and Laravel's `/up` health endpoint answers, and fails if ECS rolls the deployment back. When it finishes, the deploy prints the app URL. Without a domain, this is the load balancer address, which serves `http://` only; `https://` times out until you add a domain.

## Check the deployment

To check the stage later, in one view (whether each service runs its last deployment, and the `/up` health endpoint):

```bash
npx sst-laravel status --stage dev --wait
```

It checks the URL the deploy saved for the stage. Pass `--url <url>` to check another address.

To see what the app logged:

```bash
npx sst-laravel logs web --stage dev --no-follow
```

To remove everything the stage created: `npx sst remove --stage dev`.

## Next steps

- Add a domain, a bigger container, or auto-scaling: [Web](web.md).
- Run queues and the scheduler: [Workers](workers.md).
- Only accept traffic from your CDN or WAF, or keep the load balancer access logs: [Load Balancer](load-balancer.md).
- Add a database, Redis, or a bucket: [Linking Resources](linking-resources.md).
- Run migrations on each deploy: [Deploying](deploying.md#deployment-script).
