# CLI

The package ships an `sst-laravel` command. Install the package first, then run the command with `npx` from your Laravel application. `npx sst-laravel --help` lists every command, and `npx sst-laravel <command> --help` shows its options.

| Command | What it does |
| --- | --- |
| [`init`](#init) | Creates `sst.config.ts` for your Laravel application. |
| [`install`](#install) | Runs `sst install`, even when `sst.config.ts` can't be built yet. |
| [`doctor`](#doctor) | Checks that the machine and app are ready to deploy. |
| [`deploy`](#deploy) | Deploys a stage. |
| [`status`](#status) | Shows the running tasks and checks the health endpoint. |
| [`ssh`](#ssh) | Opens a shell in a running container. |
| [`command:run`](#commandrun) | Runs an Artisan or shell command in a running container. |
| [`logs`](#logs) | Streams the logs of a running service. |
| [`env:push`](#envpush) | Pushes a local `.env` file to AWS Secrets Manager. |
| [`env:pull`](#envpull) | Pulls the environment from AWS Secrets Manager into a local file. |
| [`guide`](#guide) | Prints the deploy guide for AI agents. |
| [`skill:install`](#skillinstall) | Installs or updates the agent skill. |
| [`github-iam`](#github-iam) | Creates an IAM role for deploying from GitHub Actions. |

Commands that work with a deployed stage (`status`, `ssh`, `command:run`, and `logs`) share these options:

- `-s, --stage <stage>` - SST stage name (required)
- `-c, --cluster <cluster>` - ECS cluster (optional, auto-detected from the stage)
- `-r, --region <region>` - AWS region (default: `AWS_REGION` or `us-east-1`)

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

Checks that the machine and Laravel app are ready to deploy. Covers the installed package, tool versions, whether Docker is running, AWS login and region, Laravel drivers, trusted proxies, `sst.config.ts`, and git-ignored secrets. Never prints secret values.

```bash
npx sst-laravel doctor
```

## `deploy`

Deploys the stage with `sst deploy`. Use it instead of `sst deploy` when you use `RemoteEnvVault`, so the secrets are fetched before the Docker build. See [Deploying](deploying.md).

```bash
npx sst-laravel deploy --stage production
```

## `status`

Checks a deployment in one view: running tasks plus an optional health-endpoint check.

```bash
npx sst-laravel status --stage production --url https://app.example.com
```

**Options:**
- `-s, --stage <stage>` - SST stage name (required unless `--cluster` is given)
- `-c, --cluster <arn>` - ECS cluster ARN (skips auto-detection)
- `-r, --region <region>` - AWS region (default: `AWS_REGION` or `us-east-1`)
- `-u, --url <url>` - Public app URL to health-check
- `-p, --path <path>` - Health path to request (default: `/up`)

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

Streams the logs for a service in real time.

```bash
npx sst-laravel logs {service} --stage production
npx sst-laravel logs web --stage production
npx sst-laravel logs reverb --stage production
npx sst-laravel logs worker --stage production
```

**Options:**
- `--since <time>` - How far back to start, for example `5m`, `1h`, or `2d` (default: `10m`)

Laravel logs only reach CloudWatch when `LOG_CHANNEL` is `stderr`. SST Laravel sets it when your environment doesn't. See [Environment Variables](environment-variables.md#variables-sst-laravel-adds).

## `env:push`

Push environment variables from a local `.env` file to AWS Secrets Manager. See [`RemoteEnvVault`](environment-variables.md#aws-secrets-manager-remoteenvvault).

```bash
npx sst-laravel env:push [options]
```

**Options:**
- `-s, --stage <stage>` - SST stage name
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

Install or update the SST Laravel agent skill. When Laravel Boost 2.0+ is set up for at least one agent, it copies the skill into `.ai/skills/sst-laravel/` and runs `php artisan boost:update`. Otherwise it installs the skill from GitHub with the [skills CLI](https://github.com/vercel-labs/skills).

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
- `--region <region>` - AWS region (default: `AWS_REGION` or `us-east-1`)
- `--role-name <name>` - IAM role name (default: `github-actions-{project}-sst-deploy`)

If the role already exists, the command leaves it unchanged. To change its trust policy, delete the role and run the command again.
