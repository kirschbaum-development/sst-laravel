import type { Input } from '@pulumi/pulumi';
import type { LaravelLink } from '../laravel-sst';
import { applyLinkedResourcesEnv, EnvCallback, extractSecrets } from './laravel-env';

interface LinkObject {
  resource: any;
  envFrom?: EnvCallback;
  environment?: EnvCallback;
  envCallback?: EnvCallback;
}

function isLinkObject(link: LaravelLink): link is LinkObject {
  return Boolean(link) && typeof link === 'object' && 'resource' in link;
}

/** The linked resources, in the format SST's `link` takes. */
export function linkResources(links: LaravelLink[] = []): any[] {
  return links.map((link) => (isLinkObject(link) ? link.resource : link));
}

/**
 * The variables the linked resources add to the env file: the defaults for
 * each resource type, then what `envFrom` returns, then the given
 * variables. `sst.Secret` links come back separately, by name.
 */
export function buildLinkedEnvironment(
  links: LaravelLink[] = [],
  variables: Record<string, Input<string | undefined>> = {},
) {
  const customEnvironment: Record<string, unknown> = {};

  for (const link of links) {
    if (!isLinkObject(link)) {
      continue;
    }

    if (link.envFrom && link.environment) {
      throw new Error('A linked resource cannot set both `envFrom` and `environment`. Use `envFrom`.');
    }

    const callback = link.envFrom || link.environment || link.envCallback;

    if (callback) {
      Object.assign(customEnvironment, callback(link.resource));
    }
  }

  const resources = linkResources(links);

  return {
    linkedEnvironment: {
      ...applyLinkedResourcesEnv(resources),
      ...customEnvironment,
      ...variables,
    } as Record<string, Input<string | undefined>>,
    linkedSecrets: extractSecrets(resources).map((secret) => ({
      name: secret.name,
      value: secret.value,
    })),
  };
}
