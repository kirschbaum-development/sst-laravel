import { Email } from "../../../.sst/platform/src/components/aws/email.js";
import { Postgres } from "../../../.sst/platform/src/components/aws/postgres.js";
import { Redis } from "../../../.sst/platform/src/components/aws/redis.js";
import { Output } from "../../../.sst/platform/node_modules/@pulumi/pulumi/index.js";
import * as pulumiAws from "../../../.sst/platform/node_modules/@pulumi/aws";
import { Queue } from "../../../.sst/platform/src/components/aws/queue.js";

type EnvType = Record<string, string | Output<string>>;
type Database = Postgres | pulumiAws.rds.Instance;
type LinkSupportedTypes = Database | Email | Queue | Redis;

export function applyLinkedResourcesEnv(links: LinkSupportedTypes[]): EnvType {
  let environment: EnvType  = {};

  links.forEach((link: LinkSupportedTypes) => {
    if (link instanceof Postgres) {
      environment = {
        ...environment,
        ...applyDatabaseEnv(link),
      };
    }

    if (link instanceof Redis) {
      environment = {
        ...environment,
        ...applyRedisEnv(link),
      };
    }

    if (link instanceof Email) {
      environment = {
        ...environment,
        ...applyEmailEnv(link),
      };
    }

    if (link instanceof Queue) {
      environment = {
        ...environment,
        ...applyQueueEnv(link),
      };
    }
  });

  return environment;
}

function applyDatabaseEnv(database: Database): EnvType {
  if (database instanceof Postgres) {
    return applyPostgresEnv(database);
  }

  if (database instanceof pulumiAws.rds.Instance) {
    return applyMySqlEnv(database);
  }

  return {};
}

function applyPostgresEnv(database: Postgres): EnvType {
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

function applyMySqlEnv(database: pulumiAws.rds.Instance): EnvType {
  const port: Output<number> = database.port;

  return {
    DB_CONNECTION: 'mysql',
    DB_HOST: database.endpoint,
    DB_DATABASE: database.dbName,
    DB_USERNAME: database.username,
    DB_PASSWORD: database.password,
    DB_PORT: port.apply(port => port.toString()),
  };
}

export function applyRedisEnv(database: Redis): EnvType {
  return {
    REDIS_HOST: database.host,
    REDIS_PORT: database.port.apply(port => port.toString()),
    REDIS_PASSWORD: database.password,
  };
}

// TODO
export function applyEmailEnv(mail: Email): EnvType {
  return {
    MAIL_MAILER: 'ses',
    // MAIL_FROM_ADDRESS: link.sender,
  };
}

// TODO
export function applyQueueEnv(queue: Queue): EnvType {
  const queueUrl: Output<string> = queue.url;


  return {
    SQS_QUEUE: queue.url,
    // MAIL_FROM_ADDRESS: link.sender,
  };
}
