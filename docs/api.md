# Laravel Component API Reference

## Constructor

```typescript
new Laravel(name: string, args: LaravelArgs, opts?: ComponentResourceOptions)
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
- **Description:** Custom domain configuration for the web service.

**Example:**
```typescript
web: {
  domain: "example.com"
}

// or with advanced configuration
web: {
  domain: {
    name: "example.com",
    cert: "arn:aws:acm:...",
    dns: false
  }
}
```

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

### `workers`
- **Type:** `LaravelWorkerConfig[]`
- **Description:** Configuration for worker services (Horizon, scheduler, or custom tasks).

#### `workers[].name`
- **Type:** `Input<string>`
- **Description:** Name of the worker service. If not provided, defaults to `worker-{index}`.

#### `workers[].scaling`
- **Type:** `ServiceArgs["scaling"]`
- **Description:** Auto-scaling configuration for the worker service.

#### `workers[].horizon`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Enable Laravel Horizon for queue processing.

#### `workers[].scheduler`
- **Type:** `Input<boolean>`
- **Default:** `false`
- **Description:** Enable Laravel scheduler (`schedule:work`).

#### `workers[].tasks`
- **Type:** `Input<{ [key: string]: Input<{ command: Input<string>; dependencies?: Input<string[]> }> }>`
- **Description:** Custom tasks to run in the worker container using s6-overlay.

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

### `config`
- **Type:** `object`
- **Description:** Configuration settings for PHP, environment, and deployment.

#### `config.php`
- **Type:** `Input<Number>`
- **Default:** `8.4`
- **Description:** PHP version to use. Available versions: 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5

#### `config.opcache`
- **Type:** `Input<boolean>`
- **Default:** `true`
- **Description:** Enable PHP OPcache for better performance.

#### `config.environment`
- **Type:** `object`
- **Description:** Environment variable configuration.

##### `config.environment.file`
- **Type:** `Input<string>`
- **Description:** Path to the `.env` file to use during build. By default, no `.env` file is used to avoid deploying incorrect environment variables from local development.

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
- **Description:** Automatically inject environment variables from linked resources. Set to `false` to disable automatic injection.

##### `config.environment.vars`
- **Type:** `FunctionArgs["environment"]`
- **Description:** Custom environment variables to inject into the application.

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

#### `config.deployment`
- **Type:** `object`
- **Description:** Deployment configuration options.

##### `config.deployment.migrate`
- **Type:** `Input<boolean>`
- **Description:** Run database migrations during deployment.

##### `config.deployment.optimize`
- **Type:** `Input<boolean>`
- **Description:** Run Laravel optimization commands during deployment.

##### `config.deployment.script`
- **Type:** `Input<string>`
- **Description:** Path to a custom deployment script to run during container startup.

**Example:**
```typescript
config: {
  deployment: {
    migrate: true,
    optimize: true,
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
const app = new Laravel("MyApp", { ... });
console.log(app.url); // https://example.com or https://xyz.elb.amazonaws.com
```

## Complete Example

```typescript
const vpc = new sst.aws.Vpc("MyVpc");
const database = new sst.aws.Postgres("MyDatabase", { vpc });
const redis = new sst.aws.Redis("MyRedis", { vpc });
const bucket = new sst.aws.Bucket("MyBucket");

const app = new Laravel("MyApp", {
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
      migrate: true,
      optimize: true
    }
  }
});

return {
  url: app.url
};
```
