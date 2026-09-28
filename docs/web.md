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

Need something SST-specific (architecture, logging, custom load balancer)? Put it under `web.advanced`, for example `web: { advanced: { architecture: 'arm64' } }`. The simple options above cover the rest.

## Load balancer health check

Laravel ships a built-in `/up` health endpoint. Point the load balancer at it via `web.healthCheck`, a shortcut over `loadBalancer.health` that targets the default forward port for you:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: { name: 'app.example.com' },
    healthCheck: { path: '/up' },
  },
});
```

All [`loadBalancer.health` options](https://sst.dev/docs/component/aws/service/#loadbalancer-health) are supported (`interval`, `timeout`, `healthyThreshold`, `unhealthyThreshold`, `successCodes`). If you set `web.loadBalancer` explicitly, `healthCheck` is ignored. Configure `loadBalancer.health` directly there.

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

This has no effect when no `domain` is set, or when you provide an explicit `web.loadBalancer` (configure `loadBalancer.ports` yourself in that case).

## Access logs

The web container runs nginx (`serversideup/php:*-fpm-nginx`), which logs every request, including the load balancer health-check pings, to stdout, where it ends up in CloudWatch. To silence those access logs, set `accessLogs: false`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    accessLogs: false,
  },
});
```

This points the serversideup `NGINX_ACCESS_LOG` variable at `/dev/null`. Error logs and the Laravel application logs are unaffected. Only the web container runs nginx, so this has no effect on workers or the Reverb service.

## Background processes

The web container can also run Horizon, the scheduler, or other long-running commands, so smaller applications don't need a separate worker. See [Background processes in the web container](workers.md#background-processes-in-the-web-container).
