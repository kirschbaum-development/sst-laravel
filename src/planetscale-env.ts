import { all, output, secret } from '@pulumi/pulumi';
import type { Input, Output } from '@pulumi/pulumi';

export interface PlanetScaleProperties {
  provider: 'planetscale';
  /** Database engine. Defaults to MySQL (Vitess). */
  engine?: 'mysql' | 'postgres';
  host: Input<string>;
  database: Input<string>;
  username: Input<string>;
  password: Input<string>;
  port?: Input<number | string>;
  /** CA bundle in the application container. */
  sslCa?: Input<string>;
}

export function getPlanetScaleProperties(link: unknown): PlanetScaleProperties | undefined {
  if (!link || typeof link !== 'object' || !('getSSTLink' in link) || typeof link.getSSTLink !== 'function') {
    return;
  }

  const properties = link.getSSTLink()?.properties;
  if (!properties || properties.provider !== 'planetscale') {
    return;
  }

  if (properties.engine !== undefined && properties.engine !== 'mysql' && properties.engine !== 'postgres') {
    throw new Error('PlanetScale link engine must be "mysql" or "postgres".');
  }

  for (const key of ['host', 'database', 'username', 'password'] as const) {
    if (properties[key] === undefined || properties[key] === null) {
      throw new Error(`PlanetScale link requires the "${key}" property.`);
    }
  }

  return properties;
}

export function applyPlanetScaleEnv(database: PlanetScaleProperties): Record<string, string | Output<string>> {
  const postgres = database.engine === 'postgres';
  const sslCa = output(database.sslCa ?? '/etc/ssl/certs/ca-certificates.crt');
  const environment = {
    DB_CONNECTION: postgres ? 'pgsql' : 'mysql',
    DB_HOST: output(database.host),
    DB_DATABASE: output(database.database),
    DB_USERNAME: output(database.username),
    DB_PASSWORD: secret(database.password),
    DB_PORT: output(database.port ?? (postgres ? 5432 : 3306)).apply(port => port.toString()),
  };

  if (!postgres) {
    return { ...environment, MYSQL_ATTR_SSL_CA: sslCa };
  }

  return {
    ...environment,
    DB_SSLMODE: 'verify-full',
    // Laravel reads URL query parameters into its connection configuration.
    // This keeps the CA path available after config:cache without a PHP config edit.
    DB_URL: all({ ...environment, sslCa }).apply(values => {
      const url = new URL(`postgresql://${values.DB_HOST}:${values.DB_PORT}`);
      url.username = encodeURIComponent(values.DB_USERNAME);
      url.password = encodeURIComponent(values.DB_PASSWORD);
      url.pathname = `/${encodeURIComponent(values.DB_DATABASE)}`;
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.set('sslrootcert', values.sslCa);
      return url.toString();
    }),
  };
}
