import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ComponentResource, Input, output, Resource, rootStackResource, runtime } from '@pulumi/pulumi';
import type { LaravelArgs, LaravelLink } from '../laravel-sst';
import { buildLinkedEnvironment } from './links';
import { EnvFile } from './env-file-resource';
import { getSecretsFingerprint } from './secrets-manager';

export interface EnvironmentFileOptions {
  /** The component that owns the resources created here. */
  parent: ComponentResource;
  name: string;
  /** The env file the images copy into the app. */
  envFilePath: string;
  absSitePath: string;
  environment?: NonNullable<LaravelArgs['config']>['environment'];
  links?: LaravelLink[];
  /** Variables added after the linked resources' (Reverb's). */
  variables: Record<string, Input<string | undefined>>;
  appUrl?: Input<string | undefined>;
  /** Notes for the deploy output. */
  messages: string[];
}

/**
 * Creates the resource that writes the `.env` the images copy, from
 * `config.environment.file` or a `RemoteEnvVault` (which wins when both are
 * set). Returns it, so the images can depend on it. Without either, the
 * images get no `.env` of their own.
 */
export function prepareEnvironmentFile(options: EnvironmentFileOptions): Resource | undefined {
  const { envFilePath, environment } = options;
  const secrets = environment?.secrets;
  const file = environment?.file as string | undefined;

  if (!secrets && !file) {
    return undefined;
  }

  const sourcePath = secrets ? undefined : path.resolve(options.absSitePath, file!);
  const source = sourcePath && fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath) : undefined;

  if (sourcePath && !source) {
    const message = `config.environment.file "${file}" was not found, so the containers get an .env without your variables.`;
    console.warn(`[sst-laravel] ${message}`);
    options.messages.push(message);
  }

  // Previews don't create the resource, but may build the images: give them
  // a file when there is none yet. A deploy rewrites it before the build.
  if (runtime.isDryRun() && !fs.existsSync(envFilePath)) {
    fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
    fs.writeFileSync(
      envFilePath,
      source ?? '# WARNING: RemoteEnvVault secrets are loaded during deployment. Preview uses a placeholder file.\n',
    );
    fs.chmodSync(envFilePath, 0o600);
  }

  const autoInject = environment?.autoInject !== false;
  const { linkedEnvironment, linkedSecrets } = autoInject
    ? buildLinkedEnvironment(options.links, options.variables)
    : { linkedEnvironment: {}, linkedSecrets: [] };

  const inputs = {
    envFilePath,
    autoInject,
    appUrl: options.appUrl,
    linkedEnvironment,
    linkedSecrets,
  };

  if (secrets) {
    return new EnvFile(
      `${options.name}-RemoteEnv`,
      {
        ...inputs,
        secretPath: secrets.path,
        fingerprint: output(secrets.path).apply((secretPath) => getSecretsFingerprint(secretPath)),
      },
      {
        parent: options.parent,
        aliases: [
          // Its name before it handled env files too, under the component
          // (0.6.1) and before it had a parent.
          { name: `${options.name}-RemoteEnv.sst.aws.RemoteEnvFile` },
          { name: `${options.name}-RemoteEnv.sst.aws.RemoteEnvFile`, parent: rootStackResource },
        ],
      },
    );
  }

  return new EnvFile(
    `${options.name}-EnvFile`,
    {
      ...inputs,
      sourcePath,
      fingerprint: source ? createHash('sha256').update(source).digest('hex') : 'missing',
    },
    { parent: options.parent },
  );
}
