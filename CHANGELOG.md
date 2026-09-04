# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `size` option (`small` | `medium` | `large`) on `web`, `workers[]`, and `reverb` mapping to valid Fargate cpu/memory pairs. Explicit `cpu`/`memory` still win over `size`.
- `advanced` block on `web`, `workers[]`, and `reverb` as the escape hatch for SST experts (`architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, `transform`).
- `envFrom` as the preferred name for the per-link environment callback (`environment` still works).
- `sst-laravel doctor` command: one readiness check for tools, AWS login/region, Laravel drivers, trusted proxies, `sst.config.ts`, and git-ignored secrets.
- `sst-laravel status` command: running tasks plus an optional `/up` health check in one non-interactive summary.
- `docs/llms.txt`: short agent quick reference (minimal config, common recipes, failure checklist).

### Changed

- `init` now generates a minimal config (web only, env file, no domain/database/workers) with cheapest-VPC guidance. The default VPC has no NAT (~$0.50/month); `nat: "ec2"` (~$6/month) is documented as the cheapest NAT when private resources need internet.
- SST passthroughs (`architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, `transform`) moved behind `advanced`. The old top-level keys still work but log a deprecation warning; `advanced` wins when both are set.
- Per-service `permissions` now override the top-level `permissions` instead of being silently dropped.
- README agent prompt is self-contained (no `node_modules` reading) and the skill (`SKILL.md`) uses plain words with `doctor`/`status` wired into every phase.

### Fixed

- `app.url` and `app.reverbUrl` return `undefined` instead of throwing when the `web`/`reverb` service is not configured.
- `config.php` type corrected from `Input<Number>` to `Input<number>`.
- Aurora database detection no longer reads the async `port` into a sync variable (always `undefined`); it uses the engine name when available and an async port check otherwise.
- Updating `.dockerignore` for the Docker build is now reported via the component messages.
- Corrected `sst deploy` to `sst-laravel deploy` in `RemoteEnvVault` docs and the `init` success message.

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
