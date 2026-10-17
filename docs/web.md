# Web

The `web` service receives your application's HTTP requests. It runs nginx and PHP-FPM behind a load balancer.

Below is an example of setting up your application to receive HTTP requests on the `laravel-sst-demo.example.com` domain (with SSL), with auto-scaling up to 3 containers.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    cpu: 1024,
    memory: 2048,
    domain: {
      dns: sst.cloudflare.dns(),
      name: 'laravel-sst-demo.example.com',
    },
    scaling: {
      min: 1,
      max: 3,
    }
  },
});
```

Without a `domain`, you can use the load balancer address for testing (http only). Check all the `web` options in the [API reference](api.md#web).

## Container size

Instead of raw `cpu`/`memory` numbers, you can pick a size: `small` (0.5 vCPU / 1 GB), `medium` (1 vCPU / 2 GB), or `large` (2 vCPU / 4 GB). Setting `cpu` or `memory` directly wins over `size`.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    size: 'small',
    scaling: {
      min: 1,
      max: 3,
    }
  },
});
```

Need something SST-specific (architecture, logging, custom listeners on the load balancer)? Put it under `web.advanced`, for example `web: { advanced: { architecture: 'arm64' } }`. The simple options above cover the rest.

## Load balancer health check

Laravel ships a built-in `/up` health endpoint. Point the load balancer at it via `web.healthCheck`, which targets the default forward port for you:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: { name: 'app.example.com' },
    healthCheck: { path: '/up' },
  },
});
```

All the [health check options of SST](https://sst.dev/docs/component/aws/service/#loadbalancer-health) are supported (`interval`, `timeout`, `healthyThreshold`, `unhealthyThreshold`, `successCodes`). If you set `web.advanced.loadBalancer`, `healthCheck` is ignored. Configure its `health` directly there.

## HTTP to HTTPS redirect

When you configure a `domain` (which provisions an SSL certificate and an HTTPS listener), HTTP (port 80) traffic is redirected to HTTPS (port 443) by default. To keep forwarding HTTP traffic straight to your application instead, set `httpsRedirect: false`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: { name: 'app.example.com' },
    httpsRedirect: false,
  },
});
```

This has no effect when no `domain` is set, or when you set `web.advanced.loadBalancer` (configure its `rules` yourself in that case).

## Access logs

The web container runs nginx (`serversideup/php:*-fpm-nginx`), which logs every request, including the load balancer health-check pings, to stdout, where it ends up in CloudWatch. These access logs are on by default, unless you enable [`web.loadBalancer.accessLogs`](load-balancer.md#access-logs-in-s3). With load balancer logs going to S3, nginx access logs default to off to avoid mixing duplicate request logs with application logs in CloudWatch. A load balancer access-log config with `enabled: false` leaves nginx logging on by default.

Set `accessLogs` explicitly to override that default. To silence nginx access logs regardless of the load balancer setting:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    accessLogs: false,
  },
});
```

This points the serversideup `NGINX_ACCESS_LOG` variable at `/dev/null`. Error logs and the Laravel application logs are unaffected. Only the web container runs nginx, so this has no effect on workers or the Reverb service.

To keep nginx access logs in CloudWatch as well as load balancer logs in S3:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    accessLogs: true,
    loadBalancer: { accessLogs: true },
  },
});
```

Keeping both can help with live request debugging in CloudWatch or requests sent directly to a container. The logs are not identical: load balancer logs include requests that never reach nginx, while nginx logs include health-check pings. AWS delivers S3 load balancer logs in roughly five-minute batches on a best-effort basis, not as a complete accounting of every request. See [AWS access log delivery](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html).

## Load balancer hardening

The load balancer is hardened by default: it only accepts TLS 1.2 and 1.3, only opens the ports it listens on, and drops invalid headers. To only accept traffic from your CDN or WAF, or to ship the load balancer access logs to S3, use the `web.loadBalancer` options. See [Load Balancer](load-balancer.md).

## Background processes

The web container can also run Horizon, the scheduler, or other long-running commands, so smaller applications don't need a separate worker. See [Background processes in the web container](workers.md#background-processes-in-the-web-container).
