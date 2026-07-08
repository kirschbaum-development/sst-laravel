# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Native ALB-hardening options on `web`, `reverb`, and load-balanced `workers[]`, replacing the hand-written `transform` callbacks previously needed for these (#7):
  - `loadBalancerAccessLogs` ships the load balancer access logs to S3. The package can create and wire up a dedicated bucket (SSE-S3 encrypted, public access blocked, regional ELB log-delivery policy attached, optional `retentionDays` lifecycle rule), or deliver to an existing bucket you own.
  - `sslPolicy` pins an SSL security policy (e.g. `ELBSecurityPolicy-TLS13-1-2-2021-06`) on the HTTPS/TLS listeners only, so plain HTTP listeners — which reject SSL policies — are left untouched.
  - `ingressCidrs` restricts the load balancer security group ingress to a fixed IPv4/IPv6 CIDR allowlist, generating one TCP rule per listener port.
- Package-generated transforms now compose with user-provided `transform` entries for the same resource (package first, then yours) instead of one clobbering the other.

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
