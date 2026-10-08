import { all, isSecret, Output, output, secret } from '@pulumi/pulumi';
import { describe, expect, it, vi } from 'vitest';

const { Postgres, Mysql, Aurora } = vi.hoisted(() => ({
  Postgres: class {},
  Mysql: class {},
  Aurora: class {},
}));

// SST installs these modules in the consuming app's .sst directory.
vi.mock('../../../../.sst/platform/src/components/component.js', () => ({ Component: class {} }));
vi.mock('../../../../.sst/platform/src/components/aws/email.js', () => ({ Email: class {} }));
vi.mock('../../../../.sst/platform/src/components/aws/mysql.js', () => ({ Mysql }));
vi.mock('../../../../.sst/platform/src/components/aws/postgres.js', () => ({ Postgres }));
vi.mock('../../../../.sst/platform/src/components/aws/redis.js', () => ({ Redis: class {} }));
vi.mock('../../../../.sst/platform/src/components/aws/queue.js', () => ({ Queue: class {} }));
vi.mock('../../../../.sst/platform/src/components/aws/aurora.js', () => ({ Aurora }));
vi.mock('../../../../.sst/platform/src/components/aws/bucket.js', () => ({ Bucket: class {} }));
vi.mock('../../../../.sst/platform/src/components/secret.js', () => ({ Secret: class {} }));

import { applyLinkedResourcesEnv } from '../src/laravel-env';
import type { PlanetScaleProperties } from '../src/planetscale-env';

function databaseLink(properties: Record<string, unknown>) {
  return {
    urn: output('urn:pulumi:test::app::sst:sst:Linkable::Database'),
    getSSTLink: () => ({ properties }),
  };
}

const credentials: PlanetScaleProperties = {
  provider: 'planetscale',
  host: 'test.connect.psdb.cloud',
  database: 'laravel',
  username: 'test-user',
  password: 'test-password',
};

function resolve<T>(value: Output<T>): Promise<T> {
  return new Promise(resolve => value.apply(result => { resolve(result); }));
}

describe('PlanetScale linked environment', () => {
  it('injects MySQL credentials and certificate verification for a marked SST link', async () => {
    const env = applyLinkedResourcesEnv([databaseLink({ ...credentials })]);

    expect(await resolve(all(env))).toEqual({
      DB_CONNECTION: 'mysql',
      DB_HOST: credentials.host,
      DB_DATABASE: credentials.database,
      DB_USERNAME: credentials.username,
      DB_PASSWORD: credentials.password,
      DB_PORT: '3306',
      MYSQL_ATTR_SSL_CA: '/etc/ssl/certs/ca-certificates.crt',
    });
    expect(await isSecret(output(env.DB_PASSWORD))).toBe(true);
    expect(await isSecret(output(env.DB_HOST))).toBe(false);
  });

  it('waits for deferred credentials and a custom port without losing secret status', async () => {
    const env = applyLinkedResourcesEnv([databaseLink({
      ...credentials,
      host: output(Promise.resolve('private.connect.psdb.cloud')),
      database: Promise.resolve('branch-db'),
      username: output('branch-user'),
      password: secret(Promise.resolve('test-$password#with-special-chars')),
      port: output(Promise.resolve(3307)),
    })]);

    expect(await resolve(all(env))).toMatchObject({
      DB_HOST: 'private.connect.psdb.cloud',
      DB_DATABASE: 'branch-db',
      DB_USERNAME: 'branch-user',
      DB_PASSWORD: 'test-$password#with-special-chars',
      DB_PORT: '3307',
    });
    expect(await isSecret(output(env.DB_PASSWORD))).toBe(true);
  });

  it('injects Postgres credentials and a secret URL with TLS verification', async () => {
    const env = applyLinkedResourcesEnv([databaseLink({
      ...credentials,
      engine: 'postgres',
      host: output(Promise.resolve('test.horizon.psdb.cloud')),
      database: 'postgres',
      username: output('app.branch|replica'),
      password: secret('test:p@ss%40/#?$word'),
    })]);
    const resolved = await resolve(all(env));

    expect(resolved).toMatchObject({
      DB_CONNECTION: 'pgsql',
      DB_HOST: 'test.horizon.psdb.cloud',
      DB_DATABASE: 'postgres',
      DB_USERNAME: 'app.branch|replica',
      DB_PASSWORD: 'test:p@ss%40/#?$word',
      DB_PORT: '5432',
      DB_SSLMODE: 'verify-full',
    });
    expect(resolved).not.toHaveProperty('MYSQL_ATTR_SSL_CA');
    const url = new URL(resolved.DB_URL!);
    expect(url.protocol).toBe('postgresql:');
    expect(url.hostname).toBe(resolved.DB_HOST);
    expect(url.port).toBe(resolved.DB_PORT);
    expect(decodeURIComponent(url.username)).toBe(resolved.DB_USERNAME);
    expect(decodeURIComponent(url.password)).toBe(resolved.DB_PASSWORD);
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(resolved.DB_DATABASE);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('sslrootcert')).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(await isSecret(output(env.DB_URL))).toBe(true);
    expect(await isSecret(output(env.DB_PASSWORD))).toBe(true);
  });

  it('supports a deferred Postgres port and a custom CA path', async () => {
    const env = applyLinkedResourcesEnv([databaseLink({
      ...credentials,
      engine: 'postgres',
      port: output(Promise.resolve('6432')),
      database: 'custom/database name',
      sslCa: output('/custom/cert bundle.crt'),
    })]);
    const resolved = await resolve(all(env));
    const url = new URL(resolved.DB_URL!);

    expect(resolved.DB_PORT).toBe('6432');
    expect(url.port).toBe('6432');
    expect(decodeURIComponent(url.pathname.slice(1))).toBe('custom/database name');
    expect(url.searchParams.get('sslrootcert')).toBe('/custom/cert bundle.crt');
  });

  it('supports an explicit MySQL engine and a custom CA path', async () => {
    const env = applyLinkedResourcesEnv([databaseLink({
      ...credentials,
      engine: 'mysql',
      sslCa: output('/custom/ca.crt'),
    })]);
    const resolved = await resolve(all(env));

    expect(resolved).toMatchObject({ DB_CONNECTION: 'mysql', MYSQL_ATTR_SSL_CA: '/custom/ca.crt' });
    expect(resolved).not.toHaveProperty('DB_URL');
    expect(resolved).not.toHaveProperty('DB_SSLMODE');
  });

  it.each(['pgsql', 'unsupported', output('postgres')])('rejects an invalid or deferred engine', engine => {
    expect(() => applyLinkedResourcesEnv([
      databaseLink({ ...credentials, engine }),
    ])).toThrow('PlanetScale link engine must be "mysql" or "postgres".');
  });

  it('does not inject database variables for unrelated or unmarked links', () => {
    expect(applyLinkedResourcesEnv([
      databaseLink({ ...credentials, provider: undefined }),
      databaseLink({ ...credentials, provider: 'another-provider' }),
      databaseLink({ value: 'some-value' }),
    ])).toEqual({});
  });

  it.each(['host', 'database', 'username', 'password'])('rejects a PlanetScale link missing %s without exposing credentials', key => {
    expect(() => applyLinkedResourcesEnv([
      databaseLink({ ...credentials, [key]: undefined }),
    ])).toThrow(`PlanetScale link requires the "${key}" property.`);
  });

  it('lets callbacks override defaults and add variables', async () => {
    const database = databaseLink({ ...credentials });
    const callback = vi.fn(() => ({
      DB_DATABASE: 'override',
      MYSQL_ATTR_SSL_CA: '/custom/ca.crt',
      CUSTOM_DB_HOST: 'custom-host',
    }));
    const env = applyLinkedResourcesEnv([database], { planetscale: callback });

    expect(callback).toHaveBeenCalledWith(database);
    expect(await resolve(all(env))).toMatchObject({
      DB_DATABASE: 'override',
      DB_USERNAME: credentials.username,
      MYSQL_ATTR_SSL_CA: '/custom/ca.crt',
      CUSTOM_DB_HOST: 'custom-host',
    });
  });

  it('uses the last linked database when more than one PlanetScale link is given', async () => {
    const env = applyLinkedResourcesEnv([
      databaseLink({ ...credentials }),
      databaseLink({ ...credentials, database: 'second', port: '3308' }),
    ]);

    expect(await resolve(all(env))).toMatchObject({ DB_DATABASE: 'second', DB_PORT: '3308' });
  });

  it('does not leave a Postgres URL when a MySQL database is linked last', async () => {
    const env = await resolve(all(applyLinkedResourcesEnv([
      databaseLink({ ...credentials, engine: 'postgres' }),
      databaseLink({ ...credentials, engine: 'mysql', database: 'last' }),
    ])));

    expect(env).toMatchObject({ DB_CONNECTION: 'mysql', DB_DATABASE: 'last', DB_PORT: '3306' });
    expect(env).not.toHaveProperty('DB_URL');
    expect(env).not.toHaveProperty('DB_SSLMODE');
  });

  it('does not carry PlanetScale TLS settings into a later AWS Postgres link', async () => {
    const postgres = Object.assign(Object.create(Postgres.prototype), {
      host: output('rds.example.com'),
      port: output(5432),
      database: output('aws-db'),
      username: output('aws-user'),
      password: secret('test-password'),
    });
    const env = await resolve(all(applyLinkedResourcesEnv([
      databaseLink({ ...credentials, engine: 'postgres' }),
      postgres,
    ])));

    expect(env).toEqual({
      DB_CONNECTION: 'pgsql',
      DB_HOST: 'rds.example.com',
      DB_PORT: '5432',
      DB_DATABASE: 'aws-db',
      DB_USERNAME: 'aws-user',
      DB_PASSWORD: 'test-password',
    });
  });

  it('lets a Postgres callback replace the full connection URL', async () => {
    const env = applyLinkedResourcesEnv([
      databaseLink({ ...credentials, engine: 'postgres' }),
    ], {
      planetscale: () => ({ DB_URL: secret('postgresql://custom.example.com/custom-db?sslmode=require') }),
    });

    expect((await resolve(all(env))).DB_URL).toBe('postgresql://custom.example.com/custom-db?sslmode=require');
    expect(await isSecret(output(env.DB_URL))).toBe(true);
  });
});

function awsDatabase(type: { prototype: object }, port: number) {
  return Object.assign(Object.create(type.prototype), {
    host: output('db.example.com'),
    port: output(port),
    database: output('app'),
    username: output('app-user'),
    password: secret('test-password'),
  });
}

describe('AWS database linked environment', () => {
  const expected = {
    DB_HOST: 'db.example.com',
    DB_DATABASE: 'app',
    DB_USERNAME: 'app-user',
    DB_PASSWORD: 'test-password',
  };

  it('injects the database variables for a linked sst.aws.Postgres', async () => {
    const env = applyLinkedResourcesEnv([awsDatabase(Postgres, 5432)]);

    expect(await resolve(all(env))).toEqual({ DB_CONNECTION: 'pgsql', DB_PORT: '5432', ...expected });
  });

  it('injects the database variables for a linked sst.aws.Mysql', async () => {
    const env = applyLinkedResourcesEnv([awsDatabase(Mysql, 3306)]);

    expect(await resolve(all(env))).toEqual({ DB_CONNECTION: 'mysql', DB_PORT: '3306', ...expected });
    expect(await isSecret(output(env.DB_PASSWORD))).toBe(true);
  });

  it.each([
    [3306, 'mysql'],
    [5432, 'pgsql'],
  ])('injects the database variables for a linked sst.aws.Aurora on port %i', async (port, connection) => {
    const env = applyLinkedResourcesEnv([awsDatabase(Aurora, port)]);

    expect(await resolve(all(env))).toEqual({ DB_CONNECTION: connection, DB_PORT: String(port), ...expected });
  });

  it('does not carry a PlanetScale Postgres URL into a later AWS MySQL link', async () => {
    const env = await resolve(all(applyLinkedResourcesEnv([
      databaseLink({ ...credentials, engine: 'postgres' }),
      awsDatabase(Mysql, 3306),
    ])));

    expect(env).toEqual({ DB_CONNECTION: 'mysql', DB_PORT: '3306', ...expected });
  });
});
