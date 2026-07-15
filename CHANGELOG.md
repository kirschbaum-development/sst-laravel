# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Experimental `provider: "cloudflare"` support for deploying the Laravel web
  application to Cloudflare Containers through Wrangler while retaining AWS as
  the default provider.
- Cloudflare runtime environment injection, `.env` deployment through Worker
  secrets, custom domains, startup health checks, instance-size inference,
  scale-to-zero, region constraints, and Worker/container observability.
- Linking for one `sst.cloudflare.D1` database through the REST-based
  `erimeilis/laravel-cloudflare-d1` driver, including defaults for Laravel's
  built-in database cache store.

### Security

- Cloudflare images use a Dockerfile-specific ignore file so local `.env` files
  are never included by the image build context.

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
