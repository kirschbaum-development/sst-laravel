# Laravel Component API Reference

## RemoteEnvVault

The `RemoteEnvVault` component manages environment variables for your Laravel application using AWS Secrets Manager. This provides a secure way to store and manage sensitive configuration values.

### Large Environment Files

Environment files that exceed AWS Secrets Manager's 64KB limit are automatically split into multiple chunks. This is handled transparently by the CLI commands - you don't need to do anything special.

When pushing a large `.env` file:
- The file is automatically split into multiple secrets (e.g., `/{app}/{stage}/env/1`, `/{app}/{stage}/env/2`, etc.)
- A metadata secret at `/{app}/{stage}/env` tracks the chunk count
- When pulling or deploying, all chunks are automatically merged back together

### Constructor

```typescript
new RemoteEnvVault(name: string, args?: RemoteEnvVaultArgs, opts?: ComponentResourceOptions)
```

### RemoteEnvVaultArgs

#### `path`
- **Type:** `Input<string>`
- **Default:** `/{app-name}/{stage}/env`
- **Description:** The path in AWS Secrets Manager where environment variables will be stored.

**Example:**
```typescript
const env = new RemoteEnvVault("Env", {
  path: "/my-app/production/env"
});
```

### Properties

#### `path`
- **Type:** `Output<string>`
- **Description:** The path in AWS Secrets Manager where environment variables are stored.

### CLI Commands

Use `sst-laravel env:push` and `sst-laravel env:pull` to manage the stored variables. See the [CLI reference](cli.md) for every command and its options.

### Usage with LaravelService

```typescript
const env = new RemoteEnvVault("Env");

new LaravelService("Laravel", {
  vpc,
  web: {
    domain: "example.com"
  },
  reverb: {
    domain: "ws.example.com"
  },
  config: {
    environment: {
      secrets: env
    }
  }
});
```

When using `RemoteEnvVault`, deploy your application using the `sst-laravel deploy` command, which will automatically fetch secrets from AWS Secrets Manager before building the Docker image:

```bash
sst-laravel deploy --stage production
```

---

## LaravelService

### Constructor

```typescript
new LaravelService(name: string, args: LaravelArgs, opts?: ComponentResourceOptions)
```

Creates a new Laravel component for deploying Laravel applications to AWS Fargate.

## LaravelArgs

### `path`
- **Type:** `Input<string>`
- **Default:** `'.'`
- **Description:** Path to the Laravel application directory.

### `link`
- **Type:** `Array<Resource | { resource: Resource; envFrom?: EnvCallback }>`
- **Description:** Resources to link to the Laravel application. Supports SST resources like databases, Redis, email services, queues, and S3 buckets. When linked, environment variables are automatically configured.

Supported resources with automatic environment variable injection:
- `Postgres` - Sets `DB_CONNECTION`, `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`
- `Mysql` - Sets `DB_CONNECTION`, `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`
- `Aurora` - Sets database variables based on port (5432 for Postgres, 3306 for MySQL)
- PlanetScale MySQL (Vitess) `sst.Linkable` - Sets `DB_CONNECTION=mysql`, `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`, and `MYSQL_ATTR_SSL_CA`
- PlanetScale Postgres `sst.Linkable` - Sets `DB_CONNECTION=pgsql`, `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`, `DB_SSLMODE=verify-full`, and `DB_URL` with TLS settings
- `Redis` - Sets `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- `Email` - Sets `MAIL_MAILER` to 'ses'
- `Queue` - Sets `SQS_QUEUE`
- `Bucket` - Sets `FILESYSTEM_DISK` to 's3', `AWS_BUCKET`

You can provide a custom `envFrom` callback function to override or extend the default environment variables:

```typescript
link: [
  {
    resource: myDatabase,
    envFrom: (resource) => ({
      CUSTOM_DB_VAR: resource.host
    })
  }
]
```

(The older `environment` name for this callback still works but `envFrom` is preferred.)

#### PlanetScale link properties

For automatic PlanetScale injection, pass an `sst.Linkable` with these `properties`. The package exports the `PlanetScaleProperties` interface for this object.

| Property | Type | Required | Default |
| --- | --- | --- | --- |
| `provider` | `'planetscale'` | Yes | — |
| `engine` | `'mysql' \| 'postgres'` | No | `'mysql'` |
| `host` | `Input<string>` | Yes | — |
| `database` | `Input<string>` | Yes | — |
| `username` | `Input<string>` | Yes | — |
| `password` | `Input<string>` | Yes | — |
| `port` | `Input<number \| string>` | No | `3306` for MySQL; `5432` for Postgres |
| `sslCa` | `Input<string>` | No | `/etc/ssl/certs/ca-certificates.crt` |

The marker and engine must be literal strings. Connection values can be plain values, promises, or Pulumi outputs. The password and Postgres connection URL remain Pulumi secrets. An incomplete marked link or an invalid engine raises an error without including credential values. For Postgres, `database` is the logical database name, usually `postgres`, not the PlanetScale project name.

MySQL uses `MYSQL_ATTR_SSL_CA` for certificate verification. Postgres uses `DB_URL` with `sslmode=verify-full` and `sslrootcert` so the TLS settings work with Laravel's configuration cache. Laravel must retain the standard MySQL SSL option or Postgres `DB_URL` option in `config/database.php`.

Postgres URL values take precedence over individual `DB_*` values. Change connection values in the link properties, or override the full `DB_URL` with an `envFrom` callback. Use `sslCa` to change the CA bundle for either engine.

Both environment file and `RemoteEnvVault` injection use this mapping. `config.environment.autoInject: false` disables it. Unmarked links are not detected as PlanetScale databases. See the [PlanetScale setup examples](linking-resources.md#planetscale).

### `permissions`
- **Type:** `Array<{ actions: string[]; resources: string[] }>`
- **Description:** IAM permissions to grant to the Laravel application containers.

**Example:**
```typescript
permissions: [
  {
    actions: ["s3:GetObject", "s3:PutObject"],
    resources: ["arn:aws:s3:::my-bucket/*"]
  }
]
```

### `vpc`
- **Type:** `ClusterArgs["vpc"]`
- **Description:** VPC configuration for the ECS cluster. Inherited from SST's Cluster component.

With an `sst.aws.Vpc`, containers run in the private subnets when the VPC has NAT (`nat: "ec2"` or `nat: "managed"`). Without NAT, private subnets have no route to the internet, so containers could not pull their image. They run in the public subnets with a public IP instead (~$3.65/month per task). Either way, the VPC security group only accepts inbound traffic from inside the VPC, so requests still come through the load balancer.

### `transform`
- **Type:** `ClusterArgs["transform"]`
- **Description:** Transform the ECS cluster, as on SST's Cluster component. The services have their own `transform` under `advanced`.

```js
transform: {
  cluster: (args) => {
    args.settings = [{ name: 'containerInsights', value: 'enhanced' }];
  },
},
```

### `web`
- **Type:** `LaravelWebArgs`
- **Description:** Configuration for the web service that handles HTTP traffic.

#### `web.domain`
- **Type:** `Input<string | { name: Input<string>; cert?: Input<string>; dns?: Input<false | Dns> }>`
- **Description:** Custom domain for the web layer. If you don't provide a domain name, you will be able to use the load balancer domain for testing (http only).

**Example (simple string):**
```typescript
web: {
  domain: "example.com"
}
```

**Example (with stage variable):**
```typescript
web: {
  domain: {
    name: `${$app.stage}.example.com`
  }
}
```

**Example (with custom certificate):**
```typescript
web: {
  domain: {
    name: "example.com",
    cert: "arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012"
  }
}
```

**Example (with custom DNS provider):**
```typescript
web: {
  domain: {
    name: "example.com",
    dns: sst.cloudflare.dns()
  }
}
```

#### `web.size`
- **Type:** `"small" | "medium" | "large"`
- **Description:** Simple container size. Maps to a valid Fargate cpu/memory pair: `small` (0.5 vCPU / 1 GB, ~$18/mo), `medium` (1 vCPU / 2 GB, ~$36/mo), `large` (2 vCPU / 4 GB, ~$72/mo). Setting `cpu` or `memory` directly wins over `size`.

**Example:**
```typescript
web: {
  size: "small",
  scaling: { min: 1, max: 3 }
}
```

#### `web.architecture`
- **Type:** `ServiceArgs["architecture"]`
- **Description:** The CPU architecture for the web service. Prefer the simple options above; SST-specific tuning lives under `web.advanced` (e.g. `advanced: { architecture: "arm64" }`). Setting this top-level key still works but logs a deprecation warning — use `advanced.architecture` instead.

#### `web.cpu`
- **Type:** `ServiceArgs["cpu"]`
- **Description:** CPU units for the web service. Wins over `web.size` when both are set.

#### `web.memory`
- **Type:** `ServiceArgs["memory"]`
- **Description:** Memory allocation for the web service. Wins over `web.size` when both are set.

#### `web.storage`
- **Type:** `ServiceArgs["storage"]`
- **Description:** Storage configuration for the web service. Setting this top-level key still works but logs a deprecation warning — use `advanced.storage` instead.

#### `web.scaling`
- **Type:** `ServiceArgs["scaling"]`
- **Description:** Auto-scaling configuration for the web service.

**Example:**
```typescript
web: {
  scaling: {
    min: 2,
    max: 10,
    cpuUtilization: 70,
    memoryUtilization: 80
  }
}
```

#### `web.logging`
- **Type:** `ServiceArgs["logging"]`
- **Description:** Logging configuration for the web service. Setting this top-level key still works but logs a deprecation warning — use `advanced.logging` instead.

#### `web.health`
- **Type:** `ServiceArgs["health"]`
- **Description:** ECS container-level health check for the web service. Distinct from `web.healthCheck` (load balancer URL check). Setting this top-level key still works but logs a deprecation warning — use `advanced.health` instead.

#### `web.healthCheck`
- **Type:** `Input<LaravelHealthCheck>`
- **Description:** Load balancer health check applied to the default forward port (`8080/http`). Shorthand so you don't have to set the full `advanced.loadBalancer` config just to set a path. Ignored when `advanced.loadBalancer` is provided — configure its `health` directly in that case.

**Example:**
```typescript
web: {
  domain: { name: 'app.example.com' },
  healthCheck: {
    path: '/up',
    successCodes: '200',
    interval: '30 seconds',
    healthyThreshold: 2,
    unhealthyThreshold: 3,
  },
}
```

#### `web.httpsRedirect`
- **Type:** `boolean`
- **Default:** `true`
- **Description:** When a `domain` is configured, redirect HTTP (port 80) traffic to the HTTPS (port 443) listener instead of forwarding it straight to the application. Set to `false` to keep forwarding HTTP traffic to the app. Has no effect when no `domain` is set (there is no HTTPS listener to redirect to) or when `advanced.loadBalancer` is provided (configure its `rules` yourself in that case).

**Example:**
```typescript
web: {
  domain: { name: 'app.example.com' },
  httpsRedirect: false,
}
```

#### `web.accessLogs`
- **Type:** `boolean`
- **Default:** `true`
- **Description:** Stream the nginx access logs from the web container to CloudWatch. The web container runs nginx (`serversideup/php:*-fpm-nginx`), which logs every request — including the load balancer health-check pings — to stdout. Set to `false` to silence those access logs (points the serversideup `NGINX_ACCESS_LOG` variable at `/dev/null`). Error logs and the Laravel application logs are unaffected. Only the web container runs nginx, so this has no effect on workers or the Reverb service.

**Example:**
```typescript
web: {
  accessLogs: false,
}
```

#### `web.loadBalancer`
- **Type:** `LaravelLoadBalancerArgs`
- **Description:** Options for the load balancer in front of the web service: `sslPolicy`, `ingressCidrs`, and `accessLogs`. The load balancer is hardened by default: its HTTPS listeners only accept TLS 1.2 and 1.3, its security group only opens the ports it listens on, and it drops HTTP headers with an invalid name. You only need this to go further (an IP allowlist, access logs) or to pick another policy. The SST load balancer config (`rules`, `domain`, `health`, ...) does not go here. Set `web.advanced.loadBalancer` for that. Any other key fails the deploy. See [Load Balancer](load-balancer.md).

**Example:**
```typescript
web: {
  domain: 'app.example.com',
  loadBalancer: {
    ingressCidrs: ['173.245.48.0/20', '2400:cb00::/32'],
    accessLogs: true,
  },
}
```

##### `web.loadBalancer.sslPolicy`
- **Type:** `Input<string>`
- **Default:** `"ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"`
- **Description:** SSL security policy for the HTTPS/TLS listeners of the load balancer. The default is the policy AWS recommends, which accepts TLS 1.2 and 1.3 only. Plain HTTP listeners reject an SSL policy, so the package leaves them untouched. See [TLS policy](load-balancer.md#tls-policy).

**Example:**
```typescript
web: {
  domain: 'app.example.com',
  loadBalancer: {
    sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-Ext2-2021-06',
  },
}
```

##### `web.loadBalancer.ingressCidrs`
- **Type:** `Input<string[]> | { v4?: Input<string[]>; v6?: Input<string[]>; ports?: Input<number[]> }`
- **Default:** `["0.0.0.0/0"]`
- **Description:** Only accept traffic to the load balancer from these CIDR blocks, for example the edge ranges of the CDN or WAF in front of it, so nobody can go around it by calling the load balancer address directly. By default the load balancer accepts traffic from everywhere, but only on the ports it listens on (SST opens every port and protocol). Pass a list (IPv4 and IPv6 blocks are told apart for you), or an object with `v4`, `v6`, and `ports`. `ports` defaults to the ports the load balancer listens on (`80`, plus `443` when a domain is set), and is only needed when `advanced.loadBalancer` is a value the package cannot read before the deploy, in which case `80` and `443` are used. See [IP allowlist](load-balancer.md#ip-allowlist).

**Example (list):**
```typescript
web: {
  loadBalancer: {
    ingressCidrs: ['173.245.48.0/20', '103.21.244.0/22', '2400:cb00::/32'],
  },
}
```

**Example (object):**
```typescript
web: {
  loadBalancer: {
    ingressCidrs: {
      v4: ['173.245.48.0/20', '103.21.244.0/22'],
      v6: ['2400:cb00::/32'],
    },
  },
}
```

##### `web.loadBalancer.accessLogs`
- **Type:** `boolean | { bucket?: Input<string> | { name: Input<string> }; prefix?: Input<string>; enabled?: Input<boolean>; retentionDays?: number | false }`
- **Default:** `false`
- **Description:** Ship the load balancer access logs to an S3 bucket. Set to `true` to let the package create the bucket, or pass an object to choose the bucket, prefix, and retention. Not the same as `web.accessLogs`, which is about the nginx logs the container sends to CloudWatch. Off by default, since it creates a bucket and adds storage cost to every stage. See [Access logs in S3](load-balancer.md#access-logs-in-s3).
  - `bucket`: An existing S3 bucket to deliver the logs to: an `sst.aws.Bucket` or a bucket name. When omitted, the package creates a dedicated bucket with public access blocked and the Elastic Load Balancing log-delivery policy attached. It uses the S3 default encryption (SSE-S3), since ELB cannot deliver logs to a bucket encrypted with a KMS key. When you bring your own bucket, you own its bucket policy. The package does not attach one, because a bucket can only have a single policy.
  - `prefix`: S3 key prefix the logs are delivered under. Leading and trailing slashes are stripped, since ELB rejects them. The prefix must not include the reserved `AWSLogs` path segment.
  - `enabled`: Whether the load balancer ships access logs. Set to `false` to stop shipping logs while keeping the bucket and the logs already in it. Defaults to `true`.
  - `retentionDays`: Days to keep access logs before they expire. Set to `false` to keep them forever. Only used when the package creates the bucket. Defaults to `90`.

**Example:**
```typescript
web: {
  loadBalancer: {
    accessLogs: true,
  },
}
```

**Example (with options):**
```typescript
web: {
  loadBalancer: {
    accessLogs: {
      prefix: 'alb',
      retentionDays: 365,
    },
  },
}
```

#### `web.horizon`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Run Laravel Horizon (`php artisan horizon`) as a supervised background process inside the web container, alongside nginx and PHP-FPM. If the process crashes, s6 restarts it in place without interrupting HTTP traffic.

#### `web.scheduler`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Run the Laravel scheduler (`php artisan schedule:work`) as a supervised background process inside the web container. If the web service scales beyond one container, every replica runs the scheduler — use `onOneServer()` with a shared cache store on your scheduled jobs.

#### `web.tasks`
- **Type:** `Input<{ [key: string]: Input<{ command: Input<string>; dependencies?: Input<string[]> }> }>`
- **Description:** Custom long-running commands supervised inside the web container, keyed by task name. `dependencies` lists services that must start first: other tasks of the same container, `base` (s6-overlay's setup, which every task depends on anyway), `nginx`, and `php-fpm`. A dependency on anything else fails the deploy before anything is built.

**Example:**
```typescript
web: {
  horizon: true,
  scheduler: true,
  tasks: {
    pulse: {
      command: "php artisan pulse:work"
    }
  }
}
```

#### `web.executionRole`
- **Type:** `ServiceArgs["executionRole"]`
- **Description:** Execution role for the web service. Setting this top-level key still works but logs a deprecation warning — use `advanced.executionRole` instead.

#### `web.permissions`
- **Type:** `ServiceArgs["permissions"]`
- **Description:** IAM permissions specific to the web service. Falls back to the top-level `permissions` when not set.

#### `web.advanced`
- **Type:** `LaravelAdvancedArgs`
- **Description:** Escape hatch for SST experts. `architecture`, `storage`, `logging`, `health`, `executionRole`, `loadBalancer`, and `transform` passed straight to the underlying `sst.aws.Service`. Values here win over the deprecated top-level keys. `advanced.loadBalancer` is the SST load balancer config (`rules`, `domain`, `health`, ...) and replaces the load balancer the package sets up; it is not the same as `web.loadBalancer`.

**Example:**
```typescript
web: {
  advanced: {
    architecture: "arm64",
  }
}
```

### `workers`
- **Type:** `LaravelWorkerConfig[]`
- **Description:** Configuration for worker services (Horizon, scheduler, or custom tasks).

#### `workers[].name`
- **Type:** `Input<string>`
- **Description:** Name of the worker service. If not provided, defaults to `worker-{index}`.

#### `workers[].horizon`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Run Laravel Horizon (`php artisan horizon`). When it exits, the container stops with its exit code and ECS replaces the task.

#### `workers[].scheduler`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Run the Laravel scheduler (`php artisan schedule:work`). When it exits, the container stops with its exit code and ECS replaces the task.

#### `workers[].tasks`
- **Type:** `Input<{ [key: string]: Input<{ command: Input<string>; dependencies?: Input<string[]> }> }>`
- **Description:** Custom long-running commands, keyed by task name. s6 restarts them in place when they exit. `dependencies` lists services that must start first: other tasks of the same worker (including `laravel-horizon` and `laravel-scheduler` when enabled), or `base`. A dependency on anything else fails the deploy before anything is built.

**Example:**
```typescript
workers: [
  {
    name: "main-worker",
    horizon: true,
    scheduler: true,
    scaling: {
      min: 1,
      max: 5
    }
  },
  {
    name: "custom-worker",
    horizon: true,
    tasks: {
      "my-task": {
        command: "php artisan my:command",
        dependencies: ["laravel-horizon"]
      }
    }
  }
]
```

#### `workers[].architecture`
- **Type:** `ServiceArgs["architecture"]`
- **Description:** The CPU architecture for the worker service. Prefer `advanced.architecture` — the top-level key still works but logs a deprecation warning.

#### `workers[].size`
- **Type:** `"small" | "medium" | "large"`
- **Description:** Simple container size (same mapping as `web.size`). Setting `cpu` or `memory` directly wins over `size`.

#### `workers[].cpu`
- **Type:** `ServiceArgs["cpu"]`
- **Description:** CPU units for the worker service. Wins over `workers[].size` when both are set.

#### `workers[].memory`
- **Type:** `ServiceArgs["memory"]`
- **Description:** Memory allocation for the worker service. Wins over `workers[].size` when both are set.

#### `workers[].storage`
- **Type:** `ServiceArgs["storage"]`
- **Description:** Storage configuration for the worker service. Prefer `advanced.storage` — the top-level key still works but logs a deprecation warning.

#### `workers[].scaling`
- **Type:** `ServiceArgs["scaling"]`
- **Description:** Auto-scaling configuration for the worker service.

#### `workers[].logging`
- **Type:** `ServiceArgs["logging"]`
- **Description:** Logging configuration for the worker service. Prefer `advanced.logging` — the top-level key still works but logs a deprecation warning.

#### `workers[].health`
- **Type:** `ServiceArgs["health"]`
- **Description:** Health check configuration for the worker service. Prefer `advanced.health` — the top-level key still works but logs a deprecation warning.

#### `workers[].executionRole`
- **Type:** `ServiceArgs["executionRole"]`
- **Description:** Execution role for the worker service. Prefer `advanced.executionRole` — the top-level key still works but logs a deprecation warning.

#### `workers[].permissions`
- **Type:** `ServiceArgs["permissions"]`
- **Description:** IAM permissions specific to this worker. Falls back to the top-level `permissions` when not set.

#### `workers[].loadBalancer`
- **Type:** `LaravelLoadBalancerArgs`
- **Description:** Same options and defaults as [`web.loadBalancer`](#webloadbalancer) (`sslPolicy`, `ingressCidrs`, `accessLogs`). Workers have no load balancer, so this only applies to a worker with `advanced.loadBalancer`. It is ignored with a warning otherwise.

#### `workers[].advanced`
- **Type:** `LaravelAdvancedArgs`
- **Description:** Escape hatch for SST experts. Same shape as `web.advanced`.

### `reverb`
- **Type:** `boolean | LaravelReverbArgs`
- **Default:** `false`
- **Description:** Configuration for a dedicated Laravel Reverb service. When enabled, SST Laravel creates a worker-style service that runs `php artisan reverb:start` and exposes it through a load balancer.

**Example:**
```typescript
reverb: {
  domain: "ws.example.com",
  scaling: {
    min: 1,
    max: 2
  }
}
```

You can also enable Reverb with defaults:

```typescript
reverb: true
```

#### `reverb.domain`
- **Type:** `Input<string | { name: Input<string>; cert?: Input<string>; dns?: Input<false | Dns> }>`
- **Description:** Custom domain for the Reverb service. If provided, SST Laravel routes HTTP and HTTPS traffic to Reverb's internal listener on port 8080 by default.

**Example (with custom DNS provider):**
```typescript
reverb: {
  domain: {
    name: "ws.example.com",
    dns: sst.cloudflare.dns()
  }
}
```

When `reverb.domain` is configured, SST Laravel auto-injects:

```env
REVERB_SERVER_HOST=0.0.0.0
REVERB_SERVER_PORT=8080
REVERB_HOST=ws.example.com
REVERB_PORT=443
REVERB_SCHEME=https
```

#### `reverb.host`
- **Type:** `string`
- **Default:** `"0.0.0.0"`
- **Description:** Host the Reverb server listens on inside the container.

#### `reverb.port`
- **Type:** `number`
- **Default:** `8080`
- **Description:** Port the Reverb server listens on inside the container. The default load balancer forwards traffic to this port.

#### `reverb.command`
- **Type:** `string`
- **Default:** `"php artisan reverb:start"`
- **Description:** Command used to start the Reverb service.

#### `reverb.architecture`
- **Type:** `ServiceArgs["architecture"]`
- **Description:** The CPU architecture for the Reverb service. Prefer `advanced.architecture` — the top-level key still works but logs a deprecation warning.

#### `reverb.size`
- **Type:** `"small" | "medium" | "large"`
- **Description:** Simple container size (same mapping as `web.size`). Setting `cpu` or `memory` directly wins over `size`.

#### `reverb.cpu`
- **Type:** `ServiceArgs["cpu"]`
- **Description:** CPU units for the Reverb service. Wins over `reverb.size` when both are set.

#### `reverb.memory`
- **Type:** `ServiceArgs["memory"]`
- **Description:** Memory allocation for the Reverb service. Wins over `reverb.size` when both are set.

#### `reverb.storage`
- **Type:** `ServiceArgs["storage"]`
- **Description:** Storage configuration for the Reverb service. Prefer `advanced.storage` — the top-level key still works but logs a deprecation warning.

#### `reverb.scaling`
- **Type:** `ServiceArgs["scaling"]`
- **Description:** Auto-scaling configuration for the Reverb service. Horizontal Reverb scaling requires Redis and `REVERB_SCALING_ENABLED=true` in your Laravel environment.

#### `reverb.logging`
- **Type:** `ServiceArgs["logging"]`
- **Description:** Logging configuration for the Reverb service. Prefer `advanced.logging` — the top-level key still works but logs a deprecation warning.

#### `reverb.health`
- **Type:** `ServiceArgs["health"]`
- **Description:** ECS health check configuration for the Reverb service. Prefer `advanced.health` — the top-level key still works but logs a deprecation warning.

#### `reverb.executionRole`
- **Type:** `ServiceArgs["executionRole"]`
- **Description:** Execution role for the Reverb service. Prefer `advanced.executionRole` — the top-level key still works but logs a deprecation warning.

#### `reverb.permissions`
- **Type:** `ServiceArgs["permissions"]`
- **Description:** IAM permissions specific to the Reverb service. Falls back to the top-level `permissions` when not set.

#### `reverb.loadBalancer`
- **Type:** `LaravelLoadBalancerArgs`
- **Description:** Options for the Reverb load balancer. Same options and defaults as [`web.loadBalancer`](#webloadbalancer) (`sslPolicy`, `ingressCidrs`, `accessLogs`).

**Example:**
```typescript
reverb: {
  domain: 'ws.example.com',
  loadBalancer: {
    ingressCidrs: ['173.245.48.0/20', '2400:cb00::/32'],
  },
}
```

#### `reverb.advanced`
- **Type:** `LaravelAdvancedArgs`
- **Description:** Escape hatch for SST experts. Same shape as `web.advanced`.

### `config`
- **Type:** `object`
- **Description:** Config settings.

#### `config.php`
- **Type:** `Input<number>`
- **Default:** `8.4`
- **Description:** PHP version. Available versions: 8.1, 8.2, 8.3, 8.4, 8.5

#### `config.opcache`
- **Type:** `Input<boolean>`
- **Default:** `true`
- **Description:** PHP Opcache should be enabled?

#### `config.environment`
- **Type:** `object`
- **Description:** Environment variable configuration.

##### `config.environment.file`
- **Type:** `Input<string>`
- **Description:** Use this option if you want to import an .env file during build. By default, SST Laravel won't use your .env file since that might be the wrong file when deploying from your local machine.

**Example:**
```typescript
config: {
  environment: {
    file: `.env.${$app.stage}`
  }
}
```

##### `config.environment.autoInject`
- **Type:** `Input<boolean>`
- **Default:** `true`
- **Description:** Set this to false in case you don't want to auto inject environment variables from your linked resources.

##### `config.environment.vars`
- **Type:** `FunctionArgs["environment"]`
- **Description:** Custom environment variables that will be automatically injected into your application.

**Example:**
```typescript
config: {
  environment: {
    vars: {
      SESSION_DRIVER: 'redis',
      QUEUE_CONNECTION: 'redis',
      LOG_CHANNEL: 'stderr'
    }
  }
}
```

##### `config.environment.secrets`
- **Type:** `RemoteEnvVault`
- **Description:** Use a `RemoteEnvVault` component to manage environment variables in AWS Secrets Manager. When provided, secrets will be fetched from AWS Secrets Manager at build time using the `sst-laravel deploy` command.

**Example:**
```typescript
const env = new RemoteEnvVault("Env");

new LaravelService("Laravel", {
  config: {
    environment: {
      secrets: env
    }
  }
});
```

> **Note:** When using `secrets`, you should deploy using `sst-laravel deploy --stage <stage>` instead of `sst deploy` directly. This ensures secrets are fetched from AWS Secrets Manager before the Docker build.

#### `config.deployment`
- **Type:** `object`
- **Description:** Custom deployment configurations.

##### `config.deployment.script`
- **Type:** `Input<string>`
- **Description:** Path to a custom deployment script to run during container startup.

**Example:**
```typescript
config: {
  deployment: {
    script: "./deploy.sh"
  }
}
```

## Properties

### `url`
- **Type:** `Output<string> | undefined`
- **Description:** The URL of the web service. If `web.domain` is set, returns the custom domain URL. Otherwise, returns the auto-generated load balancer URL. `undefined` when no `web` service is configured.

**Example:**
```typescript
const app = new LaravelService("MyApp", { ... });
console.log(app.url); // https://example.com or https://xyz.elb.amazonaws.com
```

### `reverbUrl`
- **Type:** `Output<string> | undefined`
- **Description:** The URL of the Reverb service. If `reverb.domain` is set, returns the custom domain URL. Otherwise, returns the auto-generated load balancer URL. `undefined` when no `reverb` service is configured.

**Example:**
```typescript
const app = new LaravelService("MyApp", { ... });
console.log(app.reverbUrl); // https://ws.example.com or https://xyz.elb.amazonaws.com
```

### `nodes`
- **Type:** `{ cluster: sst.aws.Cluster; web?: sst.aws.Service; reverb?: sst.aws.Service; workers: Record<string, sst.aws.Service> }`
- **Description:** The underlying resources: the ECS cluster and the `sst.aws.Service` of web, Reverb, and each worker (by worker name). Use them to add alarms, permissions, or outputs of your own. Resource options passed to `LaravelService` (such as `provider` or `protect`) apply to all of them.

**Example:**
```typescript
const app = new LaravelService("MyApp", { ... });

return {
  queue: app.nodes.workers.queue.service,
};
```

## Complete Example

```typescript
const vpc = new sst.aws.Vpc("MyVpc");
const database = new sst.aws.Postgres("MyDatabase", { vpc });
const redis = new sst.aws.Redis("MyRedis", { vpc });
const bucket = new sst.aws.Bucket("MyBucket");

const app = new LaravelService("MyApp", {
  path: "./",
  vpc,
  
  link: [database, redis, bucket],
  
  permissions: [
    {
      actions: ["s3:*"],
      resources: [bucket.arn, `${bucket.arn}/*`]
    }
  ],
  
  web: {
    domain: "example.com",
    scaling: {
      min: 2,
      max: 10
    }
  },

  reverb: {
    domain: "ws.example.com",
    scaling: {
      min: 1,
      max: 2
    }
  },
  
  workers: [
    {
      name: "queue-worker",
      horizon: true,
      scheduler: true,
      scaling: {
        min: 1,
        max: 5
      }
    }
  ],
  
  config: {
    php: 8.4,
    opcache: true,
    
    environment: {
      file: `.env.${$app.stage}`,
      autoInject: true,
      vars: {
        SESSION_DRIVER: 'redis',
        QUEUE_CONNECTION: 'redis'
      }
    },
    
    deployment: {
      script: "./deploy.sh"
    }
  }
});

return {
  url: app.url,
  reverbUrl: app.reverbUrl
};
```

## Example with RemoteEnvVault (Secrets Manager)

```typescript
const vpc = new sst.aws.Vpc("MyVpc");
const database = new sst.aws.Postgres("MyDatabase", { vpc });
const redis = new sst.aws.Redis("MyRedis", { vpc });

// Create environment secrets manager
const env = new RemoteEnvVault("Env");

const app = new LaravelService("MyApp", {
  path: "./",
  vpc,
  
  link: [database, redis],
  
  web: {
    domain: "example.com",
    scaling: {
      min: 2,
      max: 10
    }
  },

  reverb: {
    domain: "ws.example.com"
  },
  
  workers: [
    {
      name: "queue-worker",
      horizon: true,
      scheduler: true
    }
  ],
  
  config: {
    php: 8.4,
    
    environment: {
      // Use secrets from AWS Secrets Manager
      secrets: env,
      // Auto-inject linked resource variables (database, redis)
      autoInject: true,
      // Additional runtime variables
      vars: {
        SESSION_DRIVER: 'redis',
        QUEUE_CONNECTION: 'redis'
      }
    }
  }
});

return {
  url: app.url,
  reverbUrl: app.reverbUrl,
  secretsPath: env.path
};
```

### Workflow with RemoteEnvVault

1. **Initial setup** - Push your `.env` file to AWS Secrets Manager:
   ```bash
   sst-laravel env:push --stage production --input .env.production
   ```

2. **Deploy** - Use the sst-laravel CLI to deploy (automatically fetches secrets):
   ```bash
   sst-laravel deploy --stage production
   ```

3. **Update secrets** - When you need to update environment variables:
   ```bash
   # Pull current secrets (creates .env.production by default)
   sst-laravel env:pull --stage production
   
   # Edit the file
   nano .env.production
   
   # Push updated secrets
   sst-laravel env:push --stage production --input .env.production
   
   # Redeploy to apply changes
   sst-laravel deploy --stage production
   ```
