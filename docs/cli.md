# CLI

The package ships an `sst-laravel` command. Install the package first, then run the command with `npx` from your Laravel application. `npx sst-laravel --help` lists every command, and `npx sst-laravel <command> --help` shows its options.

| Command | What it does |
| --- | --- |
| [`init`](#init) | Creates `sst.config.ts` for your Laravel application. |
| [`install`](#install) | Runs `sst install`, even when `sst.config.ts` can't be built yet. |
| [`doctor`](#doctor) | Checks that the machine and app are ready to deploy. |
| [`deploy`](#deploy) | Deploys a stage and waits until ECS runs the new revision. |
| [`status`](#status) | Checks expected service revisions, private ECR images, and the health endpoint. |
| [`ssh`](#ssh) | Opens a shell in a running container. |
| [`command:run`](#commandrun) | Runs an Artisan or shell command in a running container. |
| [`logs`](#logs) | Prints or streams the logs of a running service. |
| [`env:push`](#envpush) | Pushes a local `.env` file to AWS Secrets Manager. |
| [`env:pull`](#envpull) | Pulls the environment from AWS Secrets Manager into a local file. |
| [`guide`](#guide) | Prints the deploy guide for AI agents. |
| [`skill:install`](#skillinstall) | Installs or updates the agent skill. |
| [`github-iam`](#github-iam) | Creates an IAM role for deploying from GitHub Actions. |

To remove a stage, use SST directly: `npx sst remove --stage <stage>`. See [Removing a stage](deploying.md#removing-a-stage).

## AWS profile and region

The commands use the AWS CLI's credentials. With several named profiles, export `AWS_PROFILE=<name>` so every `sst-laravel` and `sst` command uses the same one.

Commands that work with a deployed stage (`status`, `ssh`, `command:run`, and `logs`) share these options:

- `-s, --stage <stage>` - SST stage name (required)
- `-c, --cluster <cluster>` - ECS cluster (optional, auto-detected from the stage)
- `-r, --region <region>` - AWS region (default: `AWS_REGION`, then the active profile's region, then `us-east-1`. `status` and `deploy` first read the `aws` provider's `region` from `sst.config.ts`.)

## `init`

Creates `sst.config.ts` with a minimal configuration: a VPC and one small web container that reads its environment from `.env.<stage>`. It installs SST and this package in the project when they are missing, and offers to install the agent skill. See [Getting Started](getting-started.md).

```bash
npx sst-laravel init
```

## `install`

Runs `sst install`. When the `.sst` folder is missing, `sst.config.ts` can't be built yet, so the command temporarily swaps it for a starter config and restores it afterwards. See [Troubleshooting](troubleshooting.md#failed-to-build-sstconfigts).

```bash
npx sst-laravel install
```

## `doctor`

Checks that the machine and Laravel app are ready to deploy. Never prints secret values.

```bash
npx sst-laravel doctor
npx sst-laravel doctor --stage production
```

**Options:**
- `-s, --stage <stage>` - Stage whose environment file to check (default: `dev`)

It checks:

- PHP, Node.js, the AWS CLI, and that the Docker daemon is reachable (the deploy builds the image on this machine);
- the AWS login (with the profile in use) and a configured region;
- that this is a Laravel app with the package installed;
- that `vendor/` is installed and, with Vite, that `public/build` exists and is newer than `resources/`, since the image copies both as they are;
- `sst.config.ts`, a non-generic app name, and that `config.php` matches the local PHP that installed `vendor/`;
- the drivers in the stage env file (or `.env.example` when it doesn't exist yet), with a warning for SQLite, and `APP_KEY`/`APP_DEBUG` in the stage file;
- trusted proxies in `bootstrap/app.php`;
- that git ignores each env file on disk and the stage file, by asking `git check-ignore` about the real files.

Items marked `FIX` make the command exit with an error. Items marked `warn` are worth a look but don't block the deploy.

## `deploy`

Deploys the stage with `sst deploy`. Use it instead of `sst deploy` when you use `RemoteEnvVault`, so the secrets are fetched before the Docker build. See [Deploying](deploying.md).

```bash
npx sst-laravel deploy --stage production
```

`sst deploy` returns as soon as ECS accepts the new revision, before the new tasks start. `deploy` then waits until every service (web, Reverb, and each worker) runs the revision it deployed, and the health endpoint answers. It exits with an error when:

- ECS rolls the deployment back, or the rollback fails. The deployment circuit breaker rolls back when the new tasks keep failing to start or failing their health checks.
- The deployment is stopped, an expected service is missing, or a referenced ECR image is unavailable.
- The health endpoint returns an error once the rollout is done.
- The rollout doesn't finish within `--timeout`.

A rolled-back app still answers on its URL, from the previous revision, so the URL alone can't tell a failed deploy from a good one. `deploy` compares ECS against the `deployment: app.deployment` output of `run()` and checks the referenced private ECR images. Missing or invalid deployment metadata fails verification with setup instructions. That makes it safe to use in CI: the job fails when the new revision isn't running.

**Options:**
- `-s, --stage <stage>` - SST stage name (required)
- `--no-wait` - Return when `sst deploy` finishes, without waiting for the rollout
- `-t, --timeout <seconds>` - How long to wait for the rollout (default: 1800)
- `-p, --path <path>` - Health path to request once the rollout is done (default: `/up`)
- `-r, --region <region>` - AWS region of the app (default: `--region`, then the `aws` provider's `region` in `sst.config.ts`, then `AWS_REGION`, the active profile, and `us-east-1`)

It saves expected targets in `.sst/laravel/deployments.json` before verification (including failed checks), and saves the app URL for [`status`](#status). The URL comes from the `url` output that `sst.config.ts` returns (the config from `init` does), or from the load balancer address when the outputs have only one. Without a domain, it also reminds you that the load balancer address serves http only.

The check needs `ecs:DescribeServices`, `ecs:ListServiceDeployments`, `ecs:DescribeServiceRevisions`, `ecs:DescribeTaskDefinition`, and `ecr:DescribeImages`. The role from [`github-iam`](#github-iam) has them.

For existing apps, add `deployment: app.deployment` to the outputs before using verified deploy/status. See [upgrading from 0.7.1](deploying.md#upgrading-from-071), including the retention sequence and opt-in external task checks.

## `status`

Checks a deployment in one view: whether each registered service runs the exact task definition in the stage's deployment output, whether its private ECR images exist, plus an optional health-endpoint check. It fails when the last deployment was rolled back or stopped, even though the previous revision still answers. Use it after `npx sst deploy`, or after `sst-laravel deploy --no-wait`, to get the same check as `sst-laravel deploy`.

```bash
npx sst-laravel status --stage dev --wait
npx sst-laravel status --stage production --url https://app.example.com
```

**Options:**
- `-s, --stage <stage>` - SST stage name (required unless `--cluster` is given)
- `-c, --cluster <arn>` - Restrict stage verification to this registered cluster. Without `--stage`, run cluster diagnostics based on ECS history; expected revisions and image availability are not verified. This diagnostic mode also needs `ecs:ListServices`.
- `-r, --region <region>` - AWS region (default: the `aws` provider's `region` in `sst.config.ts`, then `AWS_REGION`, the active profile, and `us-east-1`)
- `-u, --url <url>` - Public app URL to health-check (default: the URL the last `sst-laravel deploy` of the stage saved on this machine)
- `-p, --path <path>` - Health path to request (default: `/up`)
- `-w, --wait [seconds]` - Keep checking every 15 seconds while ECS rolls out, up to this long (default: 1800). Use it right after a deploy, which returns before the new tasks pass the health check.

Without `--wait`, a rollout in progress makes it exit with an error. A 502 or 503 right after a deploy means the load balancer has no healthy task yet. Without a domain, the load balancer address only serves `http://`; `status` says so when you pass an `https://` address.

Laravel's `/up` route doesn't touch the database. To check the database and the migrations, run `npx sst-laravel command:run migrate:status --stage <stage>`.

## `ssh`

Connects to your running ECS containers for debugging and troubleshooting.

```bash
npx sst-laravel ssh --stage production
```

This will list all running tasks in your cluster and let you choose which one to connect to.

**Connect to a specific service:**

```bash
npx sst-laravel ssh web --stage production
npx sst-laravel ssh worker --stage production
npx sst-laravel ssh reverb --stage production
```

If you are naming your workers differently, you can specify the worker name:

```bash
npx sst-laravel ssh {worker-name} --stage production
```

## `command:run`

Runs a command in a running container. The command is prefixed with `php artisan` unless you pass `--raw`.

```bash
npx sst-laravel command:run migrate:status --stage production
npx sst-laravel command:run queue:retry all --stage production --service worker
npx sst-laravel command:run --raw "php -v" --stage production
```

**Options:**
- `--service <service>` - Service to run the command in: `web`, `worker`, or a worker name (default: `web`)
- `--container <container>` - Container name override
- `--raw` - Run the command as given, without `php artisan`

## `logs`

Prints or streams the logs of a service.

```bash
npx sst-laravel logs web --stage production
npx sst-laravel logs web --stage production --no-follow --since 30m
npx sst-laravel logs web --stage production --no-follow --filter "?ERROR ?Exception"
npx sst-laravel logs worker --stage production
```

**Options:**
- `--no-follow` - Print the recent logs and exit. By default the command keeps streaming until you stop it with Ctrl+C.
- `--since <time>` - How far back to start, for example `5m`, `1h`, or `2d` (default: `10m`)
- `--filter <pattern>` - Only show lines matching a [CloudWatch filter pattern](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html), for example `ERROR` or `"?migrat ?Exception"`

The output has no color codes, so it reads cleanly in a script or an agent transcript.

Laravel logs only reach CloudWatch when `LOG_CHANNEL` is `stderr`. SST Laravel sets it when your environment doesn't. See [Environment Variables](environment-variables.md#variables-sst-laravel-adds).

## `env:push`

Push environment variables from a local `.env` file to AWS Secrets Manager. See [`RemoteEnvVault`](environment-variables.md#aws-secrets-manager-remoteenvvault).

```bash
npx sst-laravel env:push [options]
```

**Options:**
- `-s, --stage <stage>` - SST stage name
- `-p, --path <path>` - Secrets Manager path (default: the `RemoteEnvVault` `path` in `sst.config.ts`, or `/{app}/{stage}/env`)
- `-i, --input <file>` - Input file path (default: `.env`)
- `-f, --force` - Push without confirmation

**Example:**
```bash
# Push .env.production to the production stage
npx sst-laravel env:push --stage production --input .env.production

# Push .env to staging with confirmation
npx sst-laravel env:push --stage staging
```

## `env:pull`

Pull environment variables from AWS Secrets Manager to a local `.env` file.

```bash
npx sst-laravel env:pull [options]
```

**Options:**
- `-s, --stage <stage>` - SST stage name
- `-p, --path <path>` - Secrets Manager path (default: the `RemoteEnvVault` `path` in `sst.config.ts`, or `/{app}/{stage}/env`)
- `-o, --output <file>` - Output file path (default: `.env.{stage}`)
- `-f, --force` - Overwrite existing file without confirmation

**Example:**
```bash
# Pull from production to .env.production
npx sst-laravel env:pull --stage production

# Pull from staging to a custom file
npx sst-laravel env:pull --stage staging --output .env.local
```

## `guide`

Print the step-by-step deploy guide for AI agents (the SST Laravel skill). Use `--reference` for the short config reference (`docs/llms.txt`).

```bash
npx sst-laravel guide
npx sst-laravel guide --reference
```

## `skill:install`

Install or update the SST Laravel agent skill from the installed package, so it matches the commands and options of the version you use. When Laravel Boost 2.0+ is set up for at least one agent, it copies the skill into `.ai/skills/sst-laravel/` and runs `php artisan boost:update`. Otherwise it copies the skill into `.agents/skills/sst-laravel/` and into the `skills` folder of every agent set up in the project (`.claude`, `.cursor`, `.gemini`, `.windsurf`, `.codex`). Run it again after upgrading the package.

```bash
npx sst-laravel skill:install
```

## `github-iam`

Creates an IAM role that GitHub Actions can assume through OIDC, and prints the workflow steps to deploy with it. It creates the GitHub OIDC provider in your AWS account if it's missing. The role gets the `AdministratorAccess` policy. See [Deploying from GitHub Actions](deploying.md#deploying-from-github-actions).

```bash
npx sst-laravel github-iam --branch main
```

**Options:**
- `-r, --repo <repo>` - GitHub repository as `owner/repo` (default: detected from the git remote)
- `-b, --branch <branch>` - Branch allowed to deploy; `*` allows all branches (default: `*`)
- `--region <region>` - AWS region (default: `AWS_REGION`, then the active profile, then `us-east-1`)
- `--role-name <name>` - IAM role name (default: `github-actions-{project}-sst-deploy`)

If the role already exists, the command leaves it unchanged. To change its trust policy, delete the role and run the command again.
