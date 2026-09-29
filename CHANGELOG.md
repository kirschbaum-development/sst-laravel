# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `size` option (`small` | `medium` | `large`) on `web`, `workers[]`, and `reverb` mapping to valid Fargate cpu/memory pairs. Explicit `cpu`/`memory` still win over `size`.
- `advanced` block on `web`, `workers[]`, and `reverb` as the escape hatch for SST experts (`architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, `transform`).
- `envFrom` as the preferred name for the per-link environment callback (`environment` still works).
- `sst-laravel doctor` command: one readiness check for tools, a running Docker, AWS login/region, Laravel drivers, trusted proxies, `sst.config.ts`, and git-ignored secrets.
- `sst-laravel status` command: running tasks plus an optional `/up` health check in one non-interactive summary.
- `sst-laravel skill:install` command: installs or updates the agent skill. With Laravel Boost 2.0+ set up, it adds the skill to `.ai/skills` and runs `boost:update`; otherwise it uses the [skills CLI](https://github.com/vercel-labs/skills).
- `sst-laravel guide` command: prints the agent deploy guide (the skill), or the short config reference with `--reference`.
- `docs/llms.txt`: short agent quick reference (minimal config, common recipes, failure checklist).
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
- SST passthroughs (`architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, `transform`) moved behind `advanced`. The old top-level keys still work but log a deprecation warning; `advanced` wins when both are set. The exception is `loadBalancer`, which has no top-level alias (see above).
- Per-service `permissions` now override the top-level `permissions` instead of being silently dropped.
- The README agent prompt is now one line that points the agent to `docs/agent-setup.md`. The skill (`SKILL.md`) uses plain words with `doctor`/`status` wired into every phase.
- Before writing any config, the agent now shows a plan and waits for a yes: what it found in the app, questions only the user can answer (a database, background work, a domain), what will be created with the monthly cost, how the deploy works, and how to remove it. It no longer leaves out a database silently when the app uses one.
- `init` installs `@kirschbaum-development/sst-laravel` in the project when it is missing, since `sst.config.ts` imports it.
- `doctor` checks that the package is installed in the project.
- `init` installs the skill the same way as `skill:install`. It only uses Laravel Boost when `boost.json` lists agents (`boost:update` fails otherwise), and the skills CLI now installs from GitHub so `npx skills update` works.
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
