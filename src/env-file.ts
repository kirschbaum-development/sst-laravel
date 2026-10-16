import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ComponentResource, Input, output, rootStackResource, runtime } from '@pulumi/pulumi';
import type { LaravelArgs, LaravelLink } from '../laravel-sst';
import { buildLinkedEnvironment } from './links';
import { EnvFile, isImageVariable } from './env-file-resource';
import { EnvStorage, envFileStorageInput } from './env-storage';
import { parseEnvFile } from './dotenv';
import { fingerprintSecrets, pullSecrets } from './secrets-manager';

/**
 * The `.env` the images copy when ECS sets the variables instead. The
 * container replaces it when it starts (see `stageEnvironmentScript`).
 */
export const PLACEHOLDER_ENV_FILE = '# sst-laravel: ECS sets the environment variables. The container writes them here when it starts.\n';

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
  /**
   * Where the variables are uploaded for ECS. Without it, the env file is
   * written for the images to copy.
   */
  storage?: EnvStorage;
  /** The containers' own variables, which `${VAR}` in the env file can read. */
  runtimeEnvironment?: Input<Record<string, Input<string>>>;
}

/**
 * Creates the resource that provides the containers' environment, from
 * `config.environment.file` or a `RemoteEnvVault` (which wins when both are
 * set). With `storage`, it uploads the variables for ECS to set, and the
 * images copy a placeholder `.env`. Otherwise it writes the `.env` the images
 * copy. Returns it, so the images can depend on it. Without either source,
 * the images get no `.env` of their own.
 */
export function prepareEnvironmentFile(options: EnvironmentFileOptions): EnvFile | undefined {
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

  if (options.storage) {
    // Nothing secret goes into the images, previews included.
    fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
    fs.writeFileSync(envFilePath, PLACEHOLDER_ENV_FILE);
    fs.chmodSync(envFilePath, 0o600);

    if (source) {
      warnAboutImageVariables(Object.keys(parseEnvFile(source.toString('utf8'))), options.messages);
    }
  } else if (runtime.isDryRun() && !fs.existsSync(envFilePath)) {
    // Previews don't create the resource, but may build the images: give them
    // a file when there is none yet. A deploy rewrites it before the build.
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
    ...(options.storage
      ? {
          storage: envFileStorageInput(options.storage),
          runtimeEnvironment: options.runtimeEnvironment,
        }
      : {}),
  };

  if (secrets) {
    return new EnvFile(
      `${options.name}-RemoteEnv`,
      {
        ...inputs,
        secretPath: secrets.path,
        fingerprint: output(secrets.path).apply(async (secretPath) => {
          const variables = await pullSecrets(secretPath);

          if (options.storage && variables) {
            warnAboutImageVariables(Object.keys(variables), options.messages);
          }

          return fingerprintSecrets(variables);
        }),
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

/**
 * Variables the images set are left out of what ECS sets: Laravel never let
 * the `.env` override them, so they had no effect there either.
 */
function warnAboutImageVariables(names: string[], messages: string[]) {
  const ignored = names.filter(isImageVariable);

  if (ignored.length > 0) {
    const message = `The environment sets ${ignored.join(', ')}, which the container image sets. They are left out, as Laravel ignored them in the .env. Set them in config.environment.vars to change them.`;
    console.warn(`[sst-laravel] ${message}`);
    messages.push(message);
  }
}
