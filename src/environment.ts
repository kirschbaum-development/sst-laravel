import { all, Input, Output, output } from '@pulumi/pulumi';
import type { LaravelDomain } from '../laravel-sst';
import { buildReverbEnvironmentVariables } from './reverb';
import type { ResolvedReverbArgs } from './services';

type EnvironmentVariables = Record<string, Input<string | undefined>>;

/**
 * The name of a `domain` option. A plain string stays a string; a name
 * that is an Output becomes `undefined` when it resolves to an empty value.
 */
export function getDomainName(domain?: LaravelDomain): Input<string | undefined> | undefined {
  if (!domain) {
    return undefined;
  }

  if (typeof domain === 'string') {
    return domain;
  }

  if (typeof domain === 'object' && 'name' in domain) {
    return output((domain as { name: Input<string> }).name).apply((name) => name || undefined);
  }

  return undefined;
}

/** `https://` and the domain name, or `undefined` without a domain. */
export function getAppUrl(domain?: LaravelDomain): Input<string | undefined> | undefined {
  const name = getDomainName(domain);

  if (name === undefined || typeof name === 'string') {
    return name && `https://${name}`;
  }

  return output(name).apply((value) => (value ? `https://${value}` : undefined));
}

/**
 * The Reverb variables the app needs: where the server listens, and the
 * public host when Reverb has a domain.
 */
export function buildReverbEnvironment(reverb?: ResolvedReverbArgs): EnvironmentVariables {
  if (!reverb) {
    return {};
  }

  const publicHost = getDomainName(reverb.domain);
  const serverVariables = buildReverbEnvironmentVariables({
    serverHost: reverb.host,
    serverPort: reverb.port,
  });

  if (!publicHost) {
    return serverVariables;
  }

  if (typeof publicHost === 'string') {
    return buildReverbEnvironmentVariables({
      publicHost,
      serverHost: reverb.host,
      serverPort: reverb.port,
    });
  }

  return {
    ...serverVariables,
    REVERB_HOST: publicHost,
    REVERB_PORT: '443',
    REVERB_SCHEME: 'https',
  };
}

/**
 * A container's environment: the auto-injected variables, then
 * `config.environment.vars`, then the service's own. `vars` may be an
 * Output, so the result is one. Variables without a value are left out.
 */
export function buildContainerEnvironment(
  injected: EnvironmentVariables,
  vars: Input<Record<string, Input<string>>> | undefined,
  service: Record<string, string>,
): Output<Record<string, string>> {
  return all([injected, vars ?? {}, service]).apply(([injectedValues, varsValues, serviceValues]) =>
    Object.fromEntries(
      Object.entries({ ...injectedValues, ...varsValues, ...serviceValues }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );
}
