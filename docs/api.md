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

The following CLI commands are available for managing environment variables:

#### `env:push`

Push environment variables from a local `.env` file to AWS Secrets Manager.

```bash
sst-laravel env:push [options]
```

**Options:**
- `-s, --stage <stage>` - SST stage name
- `-i, --input <file>` - Input file path (default: `.env`)
- `-f, --force` - Push without confirmation

**Example:**
```bash
# Push .env.production to the production stage
sst-laravel env:push --stage production --input .env.production

# Push .env to staging with confirmation
sst-laravel env:push --stage staging
```

#### `env:pull`

Pull environment variables from AWS Secrets Manager to a local `.env` file.

```bash
sst-laravel env:pull [options]
```

**Options:**
- `-s, --stage <stage>` - SST stage name
- `-o, --output <file>` - Output file path (default: `.env.{stage}`)
- `-f, --force` - Overwrite existing file without confirmation

**Example:**
```bash
# Pull from production to .env.production
sst-laravel env:pull --stage production

# Pull from staging to a custom file
sst-laravel env:pull --stage staging --output .env.local
```

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
- **Type:** `Array<Resource | { resource: Resource; environment?: EnvCallback }>`
- **Description:** Resources to link to the Laravel application. Supports SST resources like databases, Redis, email services, queues, and S3 buckets. When linked, environment variables are automatically configured.

Supported resources with automatic environment variable injection:
- `Postgres` - Sets `DB_CONNECTION`, `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`
- `Mysql` - Sets `DB_CONNECTION`, `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`
- `Aurora` - Sets database variables based on port (5432 for Postgres, 3306 for MySQL)
- `Redis` - Sets `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- `Email` - Sets `MAIL_MAILER` to 'ses'
- `Queue` - Sets `SQS_QUEUE`
- `Bucket` - Sets `FILESYSTEM_DISK` to 's3', `AWS_BUCKET`

You can provide a custom `environment` callback function to override or extend the default environment variables:

```typescript
link: [
  {
    resource: myDatabase,
    environment: (resource) => ({
      CUSTOM_DB_VAR: resource.host
    })
  }
]
```

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

#### `web.architecture`
- **Type:** `ServiceArgs["architecture"]`
- **Description:** The CPU architecture for the web service.

#### `web.cpu`
- **Type:** `ServiceArgs["cpu"]`
- **Description:** CPU units for the web service.

#### `web.memory`
- **Type:** `ServiceArgs["memory"]`
- **Description:** Memory allocation for the web service.

#### `web.storage`
- **Type:** `ServiceArgs["storage"]`
- **Description:** Storage configuration for the web service.

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
- **Description:** Logging configuration for the web service.

#### `web.health`
- **Type:** `ServiceArgs["health"]`
- **Description:** ECS container-level health check for the web service. Distinct from `web.healthCheck` (load balancer).

#### `web.healthCheck`
- **Type:** `Input<LaravelHealthCheck>`
- **Description:** Load balancer health check applied to the default forward port (`8080/http`). Shorthand so you don't have to override the full `loadBalancer` config just to set a path. Ignored when `loadBalancer` is provided — configure `loadBalancer.health` directly in that case.

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
- **Description:** When a `domain` is configured, redirect HTTP (port 80) traffic to the HTTPS (port 443) listener instead of forwarding it straight to the application. Set to `false` to keep forwarding HTTP traffic to the app. Has no effect when no `domain` is set (there is no HTTPS listener to redirect to) or when an explicit `loadBalancer` is provided.

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

#### `web.executionRole`
- **Type:** `ServiceArgs["executionRole"]`
- **Description:** Execution role for the web service.

#### `web.permissions`
- **Type:** `ServiceArgs["permissions"]`
- **Description:** IAM permissions specific to the web service.

### `workers`
- **Type:** `LaravelWorkerConfig[]`
- **Description:** Configuration for worker services (Horizon, scheduler, or custom tasks).

#### `workers[].name`
- **Type:** `Input<string>`
- **Description:** Name of the worker service. If not provided, defaults to `worker-{index}`.

#### `workers[].horizon`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Running horizon?

#### `workers[].scheduler`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Running scheduler?

#### `workers[].tasks`
- **Type:** `Input<{ [key: string]: Input<{ command: Input<string>; dependencies?: Input<string[]> }> }>`
- **Description:** Multiple tasks can be run in the worker.

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
- **Description:** The CPU architecture for the worker service.

#### `workers[].cpu`
- **Type:** `ServiceArgs["cpu"]`
- **Description:** CPU units for the worker service.

#### `workers[].memory`
- **Type:** `ServiceArgs["memory"]`
- **Description:** Memory allocation for the worker service.

#### `workers[].storage`
- **Type:** `ServiceArgs["storage"]`
- **Description:** Storage configuration for the worker service.

#### `workers[].scaling`
- **Type:** `ServiceArgs["scaling"]`
- **Description:** Auto-scaling configuration for the worker service.

#### `workers[].logging`
- **Type:** `ServiceArgs["logging"]`
- **Description:** Logging configuration for the worker service.

#### `workers[].health`
- **Type:** `ServiceArgs["health"]`
- **Description:** Health check configuration for the worker service.

#### `workers[].executionRole`
- **Type:** `ServiceArgs["executionRole"]`
- **Description:** Execution role for the worker service.

#### `workers[].permissions`
- **Type:** `ServiceArgs["permissions"]`
- **Description:** IAM permissions specific to this worker.

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
- **Description:** The CPU architecture for the Reverb service.

#### `reverb.cpu`
- **Type:** `ServiceArgs["cpu"]`
- **Description:** CPU units for the Reverb service.

#### `reverb.memory`
- **Type:** `ServiceArgs["memory"]`
- **Description:** Memory allocation for the Reverb service.

#### `reverb.storage`
- **Type:** `ServiceArgs["storage"]`
- **Description:** Storage configuration for the Reverb service.

#### `reverb.scaling`
- **Type:** `ServiceArgs["scaling"]`
- **Description:** Auto-scaling configuration for the Reverb service. Horizontal Reverb scaling requires Redis and `REVERB_SCALING_ENABLED=true` in your Laravel environment.

#### `reverb.logging`
- **Type:** `ServiceArgs["logging"]`
- **Description:** Logging configuration for the Reverb service.

#### `reverb.health`
- **Type:** `ServiceArgs["health"]`
- **Description:** ECS health check configuration for the Reverb service.

#### `reverb.executionRole`
- **Type:** `ServiceArgs["executionRole"]`
- **Description:** Execution role for the Reverb service.

#### `reverb.permissions`
- **Type:** `ServiceArgs["permissions"]`
- **Description:** IAM permissions specific to the Reverb service.

### `config`
- **Type:** `object`
- **Description:** Config settings.

#### `config.php`
- **Type:** `Input<Number>`
- **Default:** `8.4`
- **Description:** PHP version. Available versions: 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5

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

These are injected as real container environment variables on every service (web, workers, and Reverb). Because the containers are built on the [Serverside Up PHP images](https://serversideup.net/open-source/docker-php/), you can also use `vars` to tune PHP itself via the `PHP_*` variables the serversideup entrypoint reads at boot:

```typescript
config: {
  environment: {
    vars: {
      PHP_MEMORY_LIMIT: '512M',       // per-request PHP memory_limit (default 256M)
      PHP_MAX_EXECUTION_TIME: '60',
      PHP_POST_MAX_SIZE: '50M',
      PHP_UPLOAD_MAX_FILE_SIZE: '50M'
    }
  }
}
```

> **Note:** `PHP_MEMORY_LIMIT` is a per-request cap inside PHP, not the container's total memory. Keep it below the task memory (`web.memory` / `workers[].memory`) to avoid out-of-memory kills, and raise the task memory alongside it when needed. See the [Serverside Up PHP docs](https://serversideup.net/open-source/docker-php/) for the full list of `PHP_*` variables.

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
- **Type:** `Output<string>`
- **Description:** The URL of the web service. If `web.domain` is set, returns the custom domain URL. Otherwise, returns the auto-generated load balancer URL.

**Example:**
```typescript
const app = new LaravelService("MyApp", { ... });
console.log(app.url); // https://example.com or https://xyz.elb.amazonaws.com
```

### `reverbUrl`
- **Type:** `Output<string>`
- **Description:** The URL of the Reverb service. If `reverb.domain` is set, returns the custom domain URL. Otherwise, returns the auto-generated load balancer URL.

**Example:**
```typescript
const app = new LaravelService("MyApp", { ... });
console.log(app.reverbUrl); // https://ws.example.com or https://xyz.elb.amazonaws.com
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
