import { Output } from "@pulumi/pulumi";
import * as pulumiAws from "@pulumi/aws";
import { Aurora, Bucket, Email, Mysql, Postgres, Queue, Redis, Secret } from './sst-platform.js';
import type { Link } from './sst-platform.js';
import { applyPlanetScaleEnv, getPlanetScaleProperties } from './planetscale-env.js';

type EnvType = Record<string, string | Output<string>>|Record<string, string | Output<string | undefined> | undefined>;
type Database = Postgres | Mysql | Aurora | pulumiAws.rds.Instance;
type LinkSupportedTypes = Database | Email | Queue | Redis | Bucket | Secret | Link.Linkable;

export type EnvCallback = (resource: any) => EnvType;
export type EnvCallbacks = {
  postgres?: EnvCallback;
  mysql?: EnvCallback;
  planetscale?: EnvCallback;
  redis?: EnvCallback;
  email?: EnvCallback;
  queue?: EnvCallback;
};

export function applyLinkedResourcesEnv(links: LinkSupportedTypes[], callbacks?: EnvCallbacks): EnvType {
  let environment: EnvType  = {};

  links.forEach((link: LinkSupportedTypes) => {
    const planetscale = getPlanetScaleProperties(link);
    if (planetscale || isDatabase(link)) {
      // A later database must not inherit another database's URL or TLS settings.
      delete environment.DB_URL;
      delete environment.DB_SSLMODE;
      delete environment.MYSQL_ATTR_SSL_CA;
    }

    if (planetscale) {
      environment = {
        ...environment,
        ...applyPlanetScaleEnv(planetscale),
        ...(callbacks?.planetscale ? callbacks.planetscale(link) : {}),
      };
      return;
    }

    if (isDatabase(link)) {
      const defaultEnv = applyDatabaseEnv(link);
      const callback = link instanceof Mysql ? callbacks?.mysql : callbacks?.postgres;

      environment = {
        ...environment,
        ...defaultEnv,
        ...(callback ? callback(link) : {}),
      };
    }

    if (link instanceof Redis) {
      const defaultEnv = applyRedisEnv(link);

      environment = {
        ...environment,
        ...defaultEnv,
        ...(callbacks?.redis ? callbacks.redis(link) : {}),
      };
    }

    if (link instanceof Email) {
      const defaultEnv = applyEmailEnv(link);

      environment = {
        ...environment,
        ...defaultEnv,
        ...(callbacks?.email ? callbacks.email(link) : {}),
      };
    }

    if (link instanceof Queue) {
      const defaultEnv = applyQueueEnv(link);

      environment = {
        ...environment,
        ...defaultEnv,
        ...(callbacks?.queue ? callbacks.queue(link) : {}),
      };
    }

    if (link instanceof Bucket) {
      const defaultEnv = applyBucketEnv(link);

      environment = {
        ...environment,
        ...defaultEnv,
      };
    }

  });

  return environment;
}

function isDatabase(link: unknown): link is Postgres | Mysql | Aurora {
  return link instanceof Postgres || link instanceof Mysql || link instanceof Aurora;
}

export function extractSecrets(links: LinkSupportedTypes[]): Secret[] {
  return links.filter((link): link is Secret => link instanceof Secret);
}

function applyDatabaseEnv(database: Database): EnvType {
  if (database instanceof Postgres) {
    return applyPostgresEnv(database);
  }

  if (database instanceof Mysql || database instanceof pulumiAws.rds.Instance) {
    return applyMySqlEnv(database);
  }

  if (database instanceof Aurora) {
    return applyAuroraEnv(database);
  }

  return {};
}

function applyAuroraEnv(database: Aurora): EnvType {
  const engine = (database as unknown as { engine?: unknown }).engine;

  if (typeof engine === 'string') {
    if (engine.includes('mysql')) {
      return applyMySqlEnv(database);
    }

    if (engine.includes('postgres')) {
      return applyPostgresEnv(database);
    }
  }

  // Without engine info, decide from the port. This stays async (via
  // `.apply`) so previews and deploys agree — reading the port into a
  // plain variable here would always be `undefined`.
  return {
    DB_CONNECTION: database.port.apply((port) =>
      port === 3306 ? 'mysql' : 'pgsql',
    ),
    DB_HOST: database.host,
    DB_DATABASE: database.database,
    DB_USERNAME: database.username,
    DB_PASSWORD: database.password,
    DB_PORT: database.port.apply((port) => port.toString()),
  };
}

function applyPostgresEnv(database: Postgres|Aurora): EnvType {
  const port: Output<number> = database.port;

  return {
    DB_CONNECTION: 'pgsql',
    DB_HOST: database.host,
    DB_DATABASE: database.database,
    DB_USERNAME: database.username,
    DB_PASSWORD: database.password,
    DB_PORT: port.apply(port => port.toString()),
  };
}

function applyMySqlEnv(database: Mysql|Aurora|pulumiAws.rds.Instance): EnvType {
  const port: Output<number> = database.port;

  return {
    DB_CONNECTION: 'mysql',
    DB_HOST: database instanceof Aurora || database instanceof Mysql ? database.host : database.endpoint,
    DB_DATABASE: database instanceof Aurora || database instanceof Mysql ? database.database : database.dbName,
    DB_USERNAME: database.username,
    DB_PASSWORD: database.password,
    DB_PORT: port.apply(port => port.toString()),
  };
}

export function applyRedisEnv(database: Redis): EnvType {
  // TODO: Check if when encryption at rest is disabled, TLS is not required/throw errors
  return {
    REDIS_HOST: database.host.apply(host => host ? `tls://${host}` : ''),
    REDIS_PORT: database.port.apply(port => port.toString()),
    REDIS_PASSWORD: database.password,
  };
}

export function applyEmailEnv(mail: Email): EnvType {
  return {
    MAIL_MAILER: 'ses',
    // MAIL_FROM_ADDRESS: link.sender,
  };
}

export function applyQueueEnv(queue: Queue): EnvType {
  const queueUrl: Output<string> = queue.url;

  return {
    SQS_QUEUE: queue.url,
  };
}

export function applyBucketEnv(bucket: Bucket): EnvType {
  return {
      FILESYSTEM_DISK: 's3',
      AWS_BUCKET: bucket.name,
  };
}
