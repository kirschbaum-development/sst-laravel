---
name: sst-laravel
description: Set up, deploy, verify, and troubleshoot Laravel applications on AWS with the @kirschbaum-development/sst-laravel package. Use when an agent must take an application from local configuration through a healthy deployment.
---

# Deploy with SST Laravel

Take the current Laravel application from inspection to a working deployment. Do not stop after writing `sst.config.ts`. Continue through deployment and health verification unless access or a required user decision blocks the work.

The user may not know AWS. Before you change anything, inspect the app, then show the user a plan in plain words and let them decide what goes in (step 2). Once they agree, do the work without asking for the same permission again.

## Use the installed package as the source of truth

Read the documentation for the installed package version before you change the application:

- In an application, run `npx sst-laravel guide --reference` first (short), then read `node_modules/@kirschbaum-development/sst-laravel/docs/api.md` only for the options you need, plus the `package.json` version in that folder.
- In the SST Laravel package repository, read `docs/llms.txt`, `docs/README.md` (it links every guide), `docs/api.md`, and `package.json`.
- Run `npx sst-laravel --help` and the relevant subcommand help before use. Do not invent options that the installed CLI does not show.

Use official SST, Laravel, and AWS documentation only when the local package documentation does not answer a version-sensitive question.

## Safety rules

- Never print, paste, or summarize secret values. You can inspect environment variable names.
- Check that each stage environment file is ignored by Git before you add secrets. Do not ignore `.env.example`.
- Do not put AWS access keys in a Laravel environment file. Use the active AWS profile, SSO session, or workload role.
- Preserve a working `sst.config.ts` and existing AWS resources. Do not replace them with the starter configuration.
- A deploy creates AWS resources that cost money. Get the user's yes to the plan (step 2) before the first deploy of a stage. Ask again only when the plan changes: new resources, a higher cost, or another account, region, or stage. Redeploying an agreed stage needs no new approval.
- Get explicit approval before you remove, replace, or import a resource in a way that can change or delete it. Check protection, retention, and backups first.
- Prefer a `dev` stage for the first deployment. Do not deploy to `production` unless the user selected it or the existing project workflow clearly requires it.

## 1. Inspect the application and AWS context

Find the Laravel root. Inspect `composer.json`, `package.json`, `.env.example`, `.gitignore`, `bootstrap/app.php`, routes, and any existing SST configuration. Detect these needs from the code and environment variable names:

- database and migrations;
- cache, session, and queue drivers (the Laravel defaults keep all three in the database);
- public file storage;
- Horizon or other queue workers;
- scheduled tasks;
- Reverb;
- mail and external services;
- a custom domain and DNS provider;
- how environment variables are managed today: stage env files, `RemoteEnvVault` or `sst.Secret` in an SST config, a secrets tool (1Password `op://` references, `doppler.yaml`, `.infisical.json`), CI workflows in `.github/workflows`.

Install the package if `package.json` does not list it yet. `sst.config.ts` imports it, and `npx sst-laravel` only runs this CLI once it is installed — before that, `npx` looks for a different, unscoped package:

```bash
npm install @kirschbaum-development/sst-laravel --save
```

The image copies the project folder as it is, so the dependencies and the built assets must be there before a deploy:

```bash
composer install
npm run build
```

Then run the readiness check — it covers the install, tools, Docker, AWS login, region, dependencies and assets, drivers, trusted proxies, and git-ignored secrets in one go:

```bash
npx sst-laravel doctor
```

Fix anything marked `FIX` before continuing; `warn` items are worth a look. Docker must be running, because the deploy builds the container image on this machine. When the machine has several AWS profiles, ask the user which one to use and export `AWS_PROFILE=<name>` for every command; do not change a profile or region without user agreement. Keep your other questions for the plan, unless one blocks the inspection.

### AWS access

`doctor` shows the AWS account, identity, and region in use. When it marks the AWS CLI, the login, or the region `FIX`, the user has to act: signing in happens in a browser, and some steps need the AWS console. Tell them what to do one step at a time, and run `doctor` again when they're done.

- **No AWS account.** They create one at https://aws.amazon.com. A separate account for these deploys keeps the costs and permissions apart from anything else they run.
- **No AWS CLI.** Install AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). Run the installer yourself when you can. When it needs `sudo` or an installer window, give the user the command.
- **Not logged in.** Recommend IAM Identity Center (AWS SSO): the sign-in is short-lived and no keys are stored on the machine. In the AWS console, they enable IAM Identity Center, create a user, and give it access to the account with a permission set. Then they run `aws configure sso` in their own terminal (it asks questions and opens a browser) and choose a profile name. From then on, `aws sso login --profile <name>` signs them in again when the session expires, and you `export AWS_PROFILE=<name>` for every command. SST's guide walks through it: https://sst.dev/docs/aws-accounts/.
- **Access keys instead.** When the user only has access keys for an IAM user, they run `aws configure` themselves. Never ask them to paste keys into the chat, and don't use the root user's keys.
- **No region.** Ask which region to deploy to (close to their users), then set it with `aws configure set region <region> --profile <name>`.
- **Permissions.** The first deploy creates a VPC, IAM roles, ECS, a load balancer, an image registry, and logs, so the identity needs broad rights. `AdministratorAccess` in a dev or sandbox account is the simplest, and what SST recommends there. For a company account, SST's guide has a narrower policy: https://sst.dev/docs/iam-credentials/#iam-permissions. When a deploy fails with `AccessDenied`, show the user the action and the resource from the error. Don't change IAM policies yourself.

## 2. Agree on a plan with the user

Before you write any configuration, send the user one message with the plan. Use plain words, and explain each AWS piece in one short line. Cover:

1. **Why SST Laravel.** Open with one or two sentences that say what the user is about to install, for example: "You are about to install SST Laravel, by Kirschbaum Development. It's an extension of SST, an open-source framework that sets up cloud infrastructure from code, and it deploys Laravel apps to AWS: your app runs in containers on AWS Fargate, in your own AWS account." Then three to five short bullets from `why-sst-laravel.md`: SST and infrastructure as code (the whole setup lives in `sst.config.ts` and runs in the user's own AWS account), auto-scaling, linking any AWS resource in a few lines, and the security it brings (an IAM role instead of long-lived AWS keys, a private network for the database). Point to `node_modules/@kirschbaum-development/sst-laravel/docs/why-sst-laravel.md` for more. Skip this when the project already uses SST Laravel.
2. **What you found.** The needs from step 1, for example: "stores users and sessions in a database", "has queued jobs", "runs scheduled tasks", "saves uploads to the local disk".
3. **Questions.** Only the decisions you can't make yourself. Give the monthly cost of each option and, except for environment variables, your recommendation. Ask them all at once (with your question or choice tool when you have one). Usually:
   - **Database**, whenever the app uses one. See [Database choices](#database-choices).
   - **Background work**, when the app has queued jobs or scheduled tasks. For a first deploy, recommend running the scheduler and a queue worker inside the web container (no extra cost, see `workers.md`). A separate worker container costs about $22/month. Without either, jobs need `QUEUE_CONNECTION=sync` and scheduled tasks don't run.
   - **Environment variables.** Always ask, unless the project already has a setup. Explain the options in plain words and don't mark one as recommended; see [Environment choices](#environment-choices).
   - **Domain.** Recommend none for the first deploy: the app gets a load balancer address (http only). A domain can come later.
   - **AWS account, region, and stage.** Show the account ID, identity, and region that `doctor` reported, so the user confirms where the resources go and who pays for them. Recommend the `dev` stage.
4. **What will be created** in their AWS account, with the rough monthly cost (on-demand prices in us-east-1; other regions cost a bit more):

   | Piece | What it does | About |
   | --- | --- | --- |
   | Web container (`small`: 0.5 vCPU, 1 GB) | Runs the app: PHP, nginx, and the code | $18 |
   | Public IP for the container | Lets the container reach the internet without a NAT gateway | $3.65 |
   | Load balancer | The front door: receives web traffic and passes it to the container | $16, plus $7.30 for its 2 public IPs |
   | Network (VPC) | The private network everything runs in | $0.50 |
   | Logs and image registry | Container logs (CloudWatch) and the stored app images (ECR) | Small, grows with traffic and deploys |

   That is about $46/month for the web-only setup. Add what the user picks: a database (about $14), Redis (about $12, or $9 with Valkey), a worker container (about $22), NAT (`nat: "ec2"` about $13, `nat: "managed"` about $73), environment variables in AWS Secrets Manager (about $0.40). A `medium` container costs $36 instead of $18, a `large` one $72.

   Then explain how the containers reach the internet, from [Network choices](#network-choices): the plan uses no NAT, and the two NAT options it could use instead, with what each costs and changes.
5. **How the deploy works.** `npx sst-laravel deploy` builds a Docker image of the app on this machine, uploads it to a private image registry in the user's AWS account, and creates or updates the resources above. The first deploy takes the longest (on an ARM machine, the x86 image builds under emulation, which is slower). Later deploys roll out the new image without downtime.

   Say that the first deploys run from this machine, and that once the app is healthy, the next step should be deploying from CI, such as GitHub Actions. Then a deploy doesn't depend on one person's laptop, Docker, and AWS login: every deploy builds from a clean checkout of the repository, and with `npx sst-laravel github-iam` the workflow gets an IAM role instead of stored AWS keys. You'll offer to set it up after the first healthy deploy.
6. **How to undo it.** `npx sst remove --stage <stage>` deletes everything in the stage. With the config from `init`, that includes a database and its data on every stage except `production`.

Wait for the answers. The user's yes to the plan approves the first deploy of that plan (see the safety rules).

### Database choices

The app uses a database when `DB_CONNECTION` is anything other than `sqlite`, when it has its own migrations, or when sessions, cache, or queue use the `database` driver. Then offer:

- **A new AWS database** (recommend it when the app stores data): `sst.aws.Postgres` for `pgsql`, `sst.aws.Mysql` for `mysql` or `mariadb`. About $14/month for the smallest one. It sits in the VPC's private subnets, and linking it injects the `DB_*` variables. Add a deployment script that runs `php artisan migrate --force`, so the tables exist (see `deploying.md`).
- **An existing database** (RDS, PlanetScale, another host). The containers must be able to reach it, over the internet or inside the VPC. PlanetScale has its own link (see `linking-resources.md`). For other hosts, put the connection values in the stage environment file.
- **No database for now** (cheapest). Say exactly what won't work, for example logins, sign-ups, and anything that saves data. Set `SESSION_DRIVER=cookie`, `CACHE_STORE=file`, and `QUEUE_CONNECTION=sync` in the stage file, so pages still load.

SQLite only fits a throwaway demo: the file lives inside the container, so every deploy or restart wipes it, and containers don't share it.

### Environment choices

The app's environment variables (`APP_KEY`, mail, payment, and API keys) have to reach the containers. Which place fits depends on how the user and their team work, so don't recommend one. Explain the trade-offs and let the user pick between:

- **An env file on this machine** (`.env.dev`, ignored by git). Each deploy uploads it to a private S3 bucket that only the containers can read, and the containers load it as `.env` when they start. It costs nothing and needs no extra setup. But only a machine with the file can deploy: teammates and CI need a copy passed around by hand, and the copies drift apart.
- **AWS Secrets Manager** (`RemoteEnvVault`). The same file lives in the user's AWS account, at `/<app>/<stage>/env`. `npx sst-laravel env:push` uploads it, `env:pull` downloads it to edit, and `npx sst-laravel deploy` fetches it before each build. Anyone with AWS access to the stage, and CI, deploys with the same values and no file to pass around. About $0.40/month per stage.
- **A store the user already has** (an S3 bucket, 1Password, Doppler, or a secret in their CI). The values stay where the team keeps them. A step before each deploy writes them to `.env.<stage>`, and the deploy uses that file like the first option. Locally that's a script that runs both; in CI, a workflow step before the deploy. It costs what the tool costs.

On top of any of these, the user can add:

- **SST secrets** for the most sensitive values (`new sst.Secret("STRIPE_SECRET")`, linked to the service). SST stores the value encrypted in the user's AWS account, the user sets it with `npx sst secret set`, and it never sits in a file on a laptop. SST Laravel adds it to the containers' environment under the same name. Each one is a line in `sst.config.ts` and a value to set, so it suits a handful of values, not the whole file.
- **Plain values in `sst.config.ts`** (`config.environment.vars`) for settings that aren't secret and belong with the code. They are committed to git, so never put a secret there.

Tell the user what you found that bears on the choice, such as CI workflows in `.github/workflows`, several people committing, or a secrets tool, and leave the choice to them. When the project already uses one of these setups, keep it and say so instead of asking.

### Network choices

The VPC is the private network the app runs in. The containers need to reach the internet to pull their image and to call outside services (mail, payments, APIs). There are three ways to do that (prices for the default 2 zones):

- **No NAT** (what `init` creates, and the cheapest). The containers run in the public subnets, each with its own public IP (about $3.65/month per container). Inbound traffic still only comes through the load balancer: the containers accept no connections from outside the VPC. The outbound IP changes whenever a container is replaced, so a service that only accepts known IPs can't allow it.
- **`nat: "ec2"`** (about $13/month: $6 for the instances, $7.30 for their 2 public IPs). SST runs a small EC2 instance (`t4g.nano` with the fck-nat image) in each zone, and the containers move to private subnets with no public IP. The outbound IPs stay fixed. The instances run in the user's account: their bandwidth is limited (a bigger `nat.ec2.instance` raises it), and if one stops, the containers in its zone can't reach the internet until it's back.
- **`nat: "managed"`** (about $73/month, plus $0.045 for every GB that goes through it, image pulls included). An AWS NAT Gateway in each zone does the same job, with fixed outbound IPs and private subnets. AWS runs it, keeps it available, and scales it with the traffic. It's about five times the price of `ec2`.

Use no NAT unless the user asks for NAT. Suggest `nat: "ec2"` when the app calls a service that only accepts known IP addresses, or when the user doesn't want public IPs on the containers. `nat: "managed"` fits when the app sends a lot of traffic out, or the team doesn't want to depend on instances in their account. NAT can be added later; the containers move to the private subnets in that deploy.

## 3. Prepare the configuration

If no SST config exists, run:

```bash
npx sst-laravel init
```

If `init` asks to install this skill and the skill is already active, decline the duplicate installation.

`init` generates a minimal config: one `LaravelService`, web only, no domain, no database, health check at `/up`, and the environment from `.env.<stage>`. It names the app after the composer project or the folder, and warns when the name is generic; SST keys its state by app name and stage, so the name must be unique in the AWS account. Start from the generated config and add only what the user agreed to in the plan.

### Set up the environment

Every option starts from a stage file. Create `.env.dev` from `.env.example` when it does not exist (not from the local `.env`: its database settings and keys are meant for this machine). Generate an application key with `php artisan key:generate --env=dev`. Then:

- set `APP_ENV=production` and `APP_DEBUG=false` for any public endpoint;
- set `LOG_CHANNEL=stderr`;
- set the database, cache, session, queue, and filesystem drivers to match the plan (files work without extra resources; mysql/pgsql/redis/s3 need linked resources);
- leave out what linked resources inject (`DB_*`, `REDIS_*`);
- enable the deployment script with migrations only when the stage has a persistent database;
- confirm that the exact environment file is ignored with `git check-ignore`.

Credentials for outside services (mail, payments, APIs) are the user's to fill in. List the variable names that still need a value and ask the user to add them to the file themselves, or to leave them for later when the app loads without them. Never ask for secret values in the chat.

Then connect it the way the user chose:

- **Env file.** Keep the `file` entry from `init`:

  ```ts
  config: {
    environment: {
      file: `.env.${$app.stage}`,
    },
  },
  ```

- **`RemoteEnvVault`.** Replace the `file` entry with the vault:

  ```ts
  const { LaravelService, RemoteEnvVault } = await import("@kirschbaum-development/sst-laravel");
  const env = new RemoteEnvVault("Env");

  // in the LaravelService
  config: {
    environment: {
      secrets: env,
    },
  },
  ```

  Confirm the AWS account, region, app name, stage, and secret path with the user, then upload the file before the first deploy: `npx sst-laravel env:push --stage <stage> --input .env.<stage>`. Keep the local file ignored by git; `npx sst-laravel env:pull --stage <stage>` recreates it. After a change, push again, then deploy.
- **SST secrets.** Declare and link each one, and remove it from the stage file:

  ```ts
  const stripeSecret = new sst.Secret("STRIPE_SECRET");

  // in the LaravelService
  link: [stripeSecret],
  ```

  The user sets each value in their own terminal before the deploy, which fails while a secret has no value: `npx sst secret set STRIPE_SECRET <value> --stage <stage>`.
- **The user's own store.** Keep the `file` entry from `init`, and follow `environment-file-sources.md`: it has the commands for S3, 1Password (a mounted Environment, `op environment read`, or `op inject`), a GitHub Actions secret, and Doppler. Write a script that fetches the file and then deploys, so they run together. The user moves the values from the stage file you prepared into their store; creating a bucket or a 1Password item is theirs to approve. When the file is missing, the deploy only warns and the containers start without the variables, so the script must stop when the fetch fails. Keep the file ignored by git.
- **Values in the config.** Add the settings that aren't secret to `config.environment.vars`.

Do not replace an existing environment setup only to follow this one. Never show the contents of an environment file.

### Add what the plan includes

Add or import only the resources in the agreed plan. Use `docs/llms.txt` and `docs/api.md` for the exact `LaravelService` options.

- Keep the VPC from `init` (no NAT) unless the user chose NAT in the plan; then add `nat: "ec2"` or `nat: "managed"` to it. See [Network choices](#network-choices).
- Link a database, Redis, bucket, or SST secret when SST manages it.
- Import an existing resource only after you verify its identifiers and ownership.
- Run Horizon, the scheduler, or a queue worker where the plan says: in the web container (`web.horizon`, `web.scheduler`, `web.tasks`) or in a `workers` entry.
- Use the first-class `reverb` option for Laravel Reverb.
- Add a domain after you know the DNS provider, certificate plan, and stage hostname.
- Leave the load balancer as it is. It is secure by default (TLS 1.2+, only the listener ports open). Add `loadBalancer.ingressCidrs` or `loadBalancer.accessLogs` only when the user asks, and confirm the IP ranges first, because every other address is blocked.
- Configure trusted proxies with the API supported by the installed Laravel version.

Keep production protection and retention settings. If the app turns out to need a resource that is not in the plan, explain it and its cost, and get a yes before you add it.

## 4. Validate and deploy

Run the application's relevant local checks first. Then use any read-only SST preview command only if it appears in `npx sst --help` for the installed version. If the preview creates anything that is not in the plan, stop and ask.

Tell the user that the deploy is starting, with the AWS identity, region, and stage, and that the first one takes several minutes. Do not ask for approval again if the plan did not change. Deploy with:

```bash
npx sst-laravel deploy --stage <stage>
```

Use this command instead of direct `sst deploy` so that `RemoteEnvVault` works when configured, and so the deploy waits for ECS to run the new revision: it fails when ECS rolls the deployment back. Keep the full error output if deployment fails. A `failed to configure registry cache importer ... not found` line during the first build is expected: the build cache does not exist yet.

The first deploy writes a `.dockerignore` when the project has none, so the image skips `.git`, `node_modules`, `.env*` files, local databases, uploads, and logs. Tell the user, and commit it with the other files.

## 5. Verify and repair

A successful infrastructure command is not enough. `npx sst-laravel deploy` waits for the rollout; after a deploy run any other way (or with `--no-wait`), keep `deployment: app.deployment` in the `run()` outputs and check the expected service revisions, private ECR image availability, and the health endpoint, keeping checking while ECS rolls out:

```bash
npx sst-laravel status --stage <stage> --wait
```

A rolled-back deploy still answers from the previous revision, so a healthy URL alone does not prove the new code runs.

It checks the URL that `npx sst-laravel deploy` saved for the stage. To check another address, pass `--url <url>`. Without a domain, the app URL is `http://`; `https://` on the load balancer address times out.

Confirm all of these items:

- the deploy command exited successfully, and `status` reports every service as live (not rolled back);
- at least one web task is running and stable;
- `GET /up`, or the configured health route, returns a successful HTTP response;
- the task does not enter a restart loop after the first request;
- when a database is linked, `npx sst-laravel command:run migrate:status --stage <stage>` lists the migrations as run. `/up` never touches the database.

If verification fails, the usual causes in order are:

1. missing or wrong `APP_KEY`;
2. trusted proxies not configured, so the app builds `http` URLs behind the `https` load balancer;
3. database unreachable (wrong host, missing link, or migrations never ran);
4. wrong health path (Laravel ships `/up` on recent versions — confirm the route exists);
5. AWS keys committed in the env file (remove them and rely on the container role instead).

Read recent errors with `npx sst-laravel logs web --stage <stage> --no-follow` (add `--since 30m` to go further back, or `--filter "?ERROR ?Exception"` to narrow it down). It reads the log groups, so it works even when no task is running. `npx sst-laravel status --stage <stage> --since 1h` lists the tasks that stopped and why, with their exit codes, and `npx sst-laravel logs:errors --stage <stage> --since 1h` groups the errors. Make one focused fix, redeploy, and verify again.

Do not ask the user to diagnose an error that you can inspect with the available CLI tools. Stop only when the same blocker needs credentials, a business choice, or permission for a destructive action.

## Completion report

Finish only when the application is healthy or a concrete external blocker remains. Report:

- deployed app name, stage, region, and URL;
- health verification result;
- resources that were created, imported, or reused;
- the environment setup, with no secret values, and how to change a value (edit the file and deploy, or `env:pull`, edit, `env:push`, and deploy);
- code and config files changed, including the skill files and the `.dockerignore` the first deploy writes;
- how to deploy again (`npx sst-laravel deploy --stage <stage>`) and how to remove the stage (`npx sst remove --stage <stage>`);
- remaining work, such as a database the user skipped, a production domain, CI, or cost review;
- when a blocker remains: the exact error and what you checked (running tasks, the health endpoint, recent logs).

To monitor a stage later, or on a schedule, use the read-only checks in `monitoring.md` (`status --since 24h --json`, `logs:errors`, `queue:status`): they never prompt, and exit 1 when something needs attention. For stack traces in the logs and the job and schedule events, suggest `composer require kirschbaum-development/sst-laravel`.

After the first healthy deployment, recommend deploying from CI as the next step, and offer to set it up (see `deploying.md#deploying-from-github-actions`). The workflow needs the environment too: with `RemoteEnvVault` the deploy fetches it, with the user's own store the workflow fetches the file first, and with an env file on this machine the user saves it as a CI secret that a step writes before the deploy, or moves to one of the other two (see `environment-file-sources.md`). Offer production hardening as well. Do not expand the first deployment into CI work without user agreement.
