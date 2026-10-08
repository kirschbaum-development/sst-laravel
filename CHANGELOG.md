# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0]

### Added

- `nodes` on `LaravelService`: the ECS cluster and the `sst.aws.Service` of web, Reverb, and each worker (by worker name), to add alarms, permissions, or outputs of your own.
- `php artisan sst-laravel:status`, `sst-laravel:doctor`, `sst-laravel:guide`, and `sst-laravel:skill:install`, so every CLI command has an Artisan command.

### Changed

- The cluster and the services are created under the `LaravelService` component, so resource options passed to it (`provider`, `protect`, `dependsOn`) apply to them too. Aliases move the existing resources on the next deploy instead of replacing them.
- The env file from `config.environment.file` is written by a resource the images wait for, the same one `RemoteEnvVault` uses, instead of while the config runs. The variables SST Laravel adds are quoted, so values with `$`, `#`, or spaces work, and `APP_URL` is added when `web.domain` is an object too. The file is readable by its owner only.
- A missing `config.environment.file` prints a warning instead of deploying an empty env file silently.
- Each `LaravelService` has its own build folder, `.sst/laravel/<name>`, so two components in one app no longer overwrite each other's env file and background processes. The images are rebuilt once on the next deploy.
- The images get the app without the `.sst` folder. They carried the files the component generates there, including a second copy of the env file, and in an app with several components the other components' env files. The Dockerfiles declare `# syntax=docker/dockerfile:1` for `COPY --exclude`, so the first build fetches that Dockerfile syntax from Docker Hub.
- Worker images copy their background processes last, so the layers before them (system packages, PHP extensions) are the same for every worker and come from the build cache.
- `ssh`, `logs`, `command:run`, and `status` find the cluster by its exact name, including the app name, and the tasks by their ECS service. A stage named `dev` could match `development` before, and two apps with the same component name could match each other's cluster. `status` lists the services by their names.
- Two workers with the same name fail with a clear message.
- The CLI reads the app name from what the `app()` function of `sst.config.ts` returns, ignoring comments. It took the first `name:` in the file, which could be a worker's or a commented-out one, and `env:push` and `env:pull` then used the wrong secret path.

### Fixed

- `transform` and `forceUpgrade` on `LaravelService` reach the ECS cluster, as on SST's Cluster component. They were accepted but ignored.

## [0.6.2]

### Added

- `status` checks the app URL that the last `sst-laravel deploy` of the stage saved when `--url` isn't given, so `npx sst-laravel status --stage dev --wait` is enough after a deploy. `deploy` takes the URL from the `url` output of `sst.config.ts` (the config from `init` returns it), or from the load balancer address when the outputs have only one, and keeps it in `.sst/laravel/urls.json`.

### Changed

- The onboarding prompt fetches `docs/agent-setup.md` from the latest npm release through jsDelivr instead of from the `main` branch, so agents no longer get instructions for commands that aren't released yet. The publish workflow clears the jsDelivr cache after each release.
- `docs/agent-setup.md` has the agent run `npx sst-laravel guide` and follow it, instead of loading the skill it just installed, which most agents only see after a restart. The skill is installed for later sessions. The rules and the report that repeated the skill are gone; the skill's report now also lists the skill files, the `.dockerignore`, and what was checked when a blocker remains.
- The agent asks where the environment variables should live, and explains the options, instead of always using an env file: an env file on this machine, or `RemoteEnvVault` in AWS Secrets Manager, plus SST secrets and `config.environment.vars`. It recommends `RemoteEnvVault` for teams and CI, keeps a setup the project already has, and never asks for secret values in the chat. `docs/environment-variables.md` has a new "Which one to use" section.
- The agent helps users without AWS access set it up: IAM Identity Center with `aws configure sso`, the region, and the permissions the first deploy needs. The plan shows the AWS account and identity in use. `doctor` suggests `aws configure sso` when there is no login, and `docs/getting-started.md` has a new AWS access section.

## [0.6.1]

### Fixed

- Linking an `sst.aws.Mysql` or `sst.aws.Aurora` database injects the `DB_*` variables, as documented. Only `sst.aws.Postgres` did before.
- `env:pull` writes values the way the deploy does, and `env:push` reads quoted values the way Laravel does (escapes, multi-line values, comments after the closing quote, `export`). Before, every pull and push added a backslash to values containing `"`.
- `env:push` and `env:pull` use the `path` of the `RemoteEnvVault` in `sst.config.ts`, filling in `$app.name` and `$app.stage`. They used the default path even when the vault set another one. The new `--path` option sets it when it can't be read from the config.
- `config.opcache` takes effect. The Dockerfiles ignored it: web containers always had OPcache on and workers always off. OPcache is now on in every container unless `config.opcache` is `false`. Unused build args are no longer passed.
- Worker and Reverb images build when the project's `.dockerignore` excludes `node_modules`, as the one the first deploy writes does. The image copied its s6 config from the package in `node_modules`; it is now copied into `.sst/laravel` first.
- `config.environment.vars` can be an Output. Before, the Reverb variables and `NGINX_ACCESS_LOG` were dropped when it was.
- The `RemoteEnvFile` resource is created under the `LaravelService` component, as intended, so resource options on the component apply to it. An alias moves the existing one instead of replacing it.

## [0.6.0]

### Added

- `size` option (`small` | `medium` | `large`) on `web`, `workers[]`, and `reverb` mapping to valid Fargate cpu/memory pairs. Explicit `cpu`/`memory` still win over `size`.
- `advanced` block on `web`, `workers[]`, and `reverb` as the escape hatch for SST experts (`architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, `transform`).
- `envFrom` as the preferred name for the per-link environment callback (`environment` still works).
- `sst-laravel doctor` command: one readiness check for tools, a reachable Docker daemon, AWS login (with the profile in use) and region, the installed dependencies and built assets, `sst.config.ts` (app name, PHP version), the stage env file (`--stage`, default `dev`) and its drivers, trusted proxies, and git-ignored secrets. It asks `git check-ignore` about each real env file instead of pattern-matching `.gitignore`, which passed `.env.production` for `.env.dev`. Warnings (`warn`) don't block; `FIX` items do.
- `sst-laravel status` command: running tasks plus an optional `/up` health check in one non-interactive summary. `--wait` keeps checking while the tasks start, since the deploy returns before they pass the health check. It points out that the load balancer address serves http only.
- `sst-laravel logs`: `--no-follow` prints the recent logs and exits, `--filter` narrows them with a CloudWatch filter pattern, and the output has no color codes.
- `sst-laravel deploy` prints the `status --wait` command when it finishes, and a note when the app runs on the http-only load balancer address.
- `sst-laravel skill:install` command: installs or updates the agent skill from the installed package, so it matches the version in use. With Laravel Boost 2.0+ set up, it adds the skill to `.ai/skills` and runs `boost:update`; otherwise it copies it to `.agents/skills` and the folder of each agent set up in the project.
- The first deploy writes a `.dockerignore` when the project has none, so the image skips `.git`, `node_modules`, every `.env*` file, local SQLite databases, uploads, logs, and tests. An existing file only gets the `.sst` lines, as before (and no longer grows a blank line on every deploy).
- `sst-laravel guide` command: prints the agent deploy guide (the skill), or the short config reference with `--reference`.
- `docs/llms.txt`: short agent quick reference (minimal config, common recipes, failure checklist).
- `docs/why-sst-laravel.md`: what SST is, and what the setup gives you (infrastructure as code, auto-scaling, linked AWS resources, security without long-lived AWS keys).
- `docs/agent-setup.md`: setup instructions for agents to fetch. They install the package, install or update the skill with `skill:install`, and follow it.
- `loadBalancer` options on `web`, `reverb`, and workers with a load balancer, so hardening it no longer needs hand-written `transform` callbacks (#7). Documented in `docs/load-balancer.md`:
  - `loadBalancer.sslPolicy` sets the SSL security policy on the HTTPS/TLS listeners only. HTTP listeners, which reject an SSL policy, are left untouched.
  - `loadBalancer.ingressCidrs` only accepts traffic to the load balancer from the given IPv4/IPv6 ranges, with one security group rule per listener port. It takes a plain list or `{ v4, v6, ports }`.
  - `loadBalancer.accessLogs` ships the load balancer access logs to S3. The package creates the bucket (private, HTTPS only, delivery limited to the load balancers of the account and region, logs kept 90 days unless `retentionDays` says otherwise), or delivers to a bucket you own.
- `advanced.transform` entries for the load balancer, its listeners, and its security group now run after the defaults and options above, so they compose instead of one replacing the other.

### Changed

- **Breaking:** `loadBalancer` on `web`, `workers[]`, and `reverb` no longer takes the SST load balancer config (`rules`, `ports`, `domain`, `health`, ...). It now holds the load balancer options (see Added). Move the SST config to `advanced.loadBalancer`. Any key `loadBalancer` does not know fails the deploy before anything is created.
- Load balancers are now hardened by default. On the next deploy, existing load balancers are updated in place:
  - HTTPS listeners use `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09`, the policy AWS recommends, instead of `ELBSecurityPolicy-2016-08`. Clients that only speak TLS 1.0 or 1.1 can no longer connect. Set `loadBalancer.sslPolicy` to pick another policy.
  - The security group only opens the ports the load balancer listens on, instead of every port and protocol. New connections can fail for a moment while the rules are replaced.
  - Application load balancers drop HTTP headers with an invalid name (anything other than letters, digits, and hyphens). Set `dropInvalidHeaderFields` to `false` in `advanced.transform.loadBalancer` to keep them.
- `init` now generates a minimal config (web only, env file, no domain/database/workers) with cheapest-VPC guidance. The default VPC has no NAT (~$0.50/month); `nat: "ec2"` (~$13/month) is documented for keeping containers in private subnets.
- `init` names the app after the composer project or the folder instead of `APP_NAME`, which turned every fresh app into `laravel`, and warns when the name is still generic: SST keys its state by app name and stage, so two projects with the same name in one AWS account overwrite each other. It sets `config.php` to the local PHP version, because the image copies the local `vendor/` folder, and adds `.sst` to `.gitignore`.
- `status`, `logs`, `ssh`, `command:run`, and `github-iam` take the region from the active AWS profile when `AWS_REGION` is not set, instead of falling back to `us-east-1`.
- SST passthroughs (`architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, `transform`) moved behind `advanced`. The old top-level keys still work but log a deprecation warning; `advanced` wins when both are set. The exception is `loadBalancer`, which has no top-level alias (see above).
- Per-service `permissions` now override the top-level `permissions` instead of being silently dropped.
- The README agent prompt is now one line that points the agent to `docs/agent-setup.md`. The skill (`SKILL.md`) uses plain words with `doctor`/`status` wired into every phase.
- Before writing any config, the agent now shows a plan and waits for a yes: a few bullets on why SST Laravel, what it found in the app, questions only the user can answer (a database, background work, a domain), what will be created with the monthly cost, how the deploy works, and how to remove it. It no longer leaves out a database silently when the app uses one.
- `init` installs `@kirschbaum-development/sst-laravel` in the project when it is missing, since `sst.config.ts` imports it.
- `doctor` checks that the package is installed in the project.
- `init` installs the skill the same way as `skill:install`. It only uses Laravel Boost when `boost.json` lists agents (`boost:update` fails otherwise).
- Documentation moved from the README into topic pages in `docs/` (getting started, web, workers, Reverb, environment variables, linking resources, deploying, CLI, troubleshooting), published at [docs.kirschbaumdevelopment.com](https://docs.kirschbaumdevelopment.com/projects/sst-laravel/). The README is now a short overview. The CLI reference now also covers `command:run`, `install`, and `github-iam`.

### Fixed

- Containers in an `sst.aws.Vpc` without NAT now run in the public subnets with a public IP, like SST's default. They were placed in private subnets with no route to the internet, so they could not pull their image and never started. VPCs with NAT keep their containers in private subnets.
- `app.url` and `app.reverbUrl` return `undefined` instead of throwing when the `web`/`reverb` service is not configured.
- `config.php` type corrected from `Input<Number>` to `Input<number>`.
- Aurora database detection no longer reads the async `port` into a sync variable (always `undefined`); it uses the engine name when available and an async port check otherwise.
- Updating `.dockerignore` for the Docker build is now reported via the component messages.
- Corrected `sst deploy` to `sst-laravel deploy` in `RemoteEnvVault` docs and the `init` success message.

## [0.5.2]

### Added

- Automatic Laravel database environment variables and TLS certificate verification for PlanetScale MySQL (Vitess) and Postgres credentials in an `sst.Linkable` with `provider: 'planetscale'`.

## [0.5.0]

### Changed

- **Breaking:** Require SST `^4.17.1`. New projects created with `sst-laravel init` install the same supported version range.

## [0.3.9]

### Added

- `web.horizon`, `web.scheduler`, and `web.tasks` options to run supervised background processes (Horizon, the Laravel scheduler, or custom commands) inside the web container via s6-overlay, without a dedicated worker service. Unlike workers, a crashed process is restarted in place so HTTP traffic is never interrupted.

### Fixed

- Stale s6 task definitions are now removed from the build directory before regeneration, so disabling `horizon`/`scheduler` or renaming a task no longer leaves the old process running (applies to web, workers, and Reverb).
- Task names are now validated (single safe path segment, not one of the reserved s6 service names `user`/`nginx`/`php-fpm`) and worker names must be a single path segment, preventing generated files from escaping the build directory and from overwriting the stock s6 services in the container image.

## [0.3.8]

### Fixed

- Forward the `cpu`, `memory`, `storage`, `architecture`, `logging`, `health`, and `executionRole` service arguments to the underlying `sst.aws.Service`. These were declared on `web`, `workers[]`, and `reverb` but never relayed, so setting them (e.g. `cpu`/`memory`) was silently a no-op and services ran on SST's defaults (0.25 vCPU / 0.5 GB) regardless of config.

## [0.3.7]

### Changed

- Enable additional PHP extensions on the worker Docker image.

## [0.3.6]

### Added

- `web.accessLogs` option to silence the web container's nginx access logs (including ALB health-check pings) by pointing `NGINX_ACCESS_LOG` at `/dev/null`, while leaving error and application logs intact.

## [0.3.5]

### Changed

- Redirect HTTP (port 80) traffic to HTTPS by default when a `web.domain` is configured. Set `web.httpsRedirect: false` to keep forwarding HTTP straight to the app.

## [0.3.4]

### Added

- `web.healthCheck` shortcut for configuring the load balancer health check on the default forward port without specifying the per-port key.

## [0.3.3]

### Added

- Laravel Reverb service support.
- Command runner.
