import { CustomResourceOptions, Input, dynamic } from '@pulumi/pulumi';
import { parseEnvFile, toEnvFileContent } from './dotenv.js';

// The provider runs in Pulumi's dynamic provider host, which gets it
// serialized: everything it uses must be in this file or in `./dotenv`, and
// modules are imported inside the functions.

export interface EnvFileInputs {
  /** Where to write the env file. */
  envFilePath: Input<string>;
  /** The env file to start from (`config.environment.file`), copied as written. */
  sourcePath?: Input<string>;
  /** The Secrets Manager path of a `RemoteEnvVault` to start from. */
  secretPath?: Input<string>;
  /** Changes with the source, so the file is rewritten when the source changes. */
  fingerprint: Input<string>;
  autoInject?: Input<boolean>;
  appUrl?: Input<string | undefined>;
  linkedEnvironment?: Input<Record<string, Input<string | undefined> | undefined>>;
  linkedSecrets?: Input<Array<{ name: Input<string>; value: Input<string> }>>;
}

export interface ResolvedEnvFileInputs {
  envFilePath: string;
  sourcePath?: string;
  secretPath?: string;
  fingerprint: string;
  autoInject?: boolean;
  appUrl?: string;
  linkedEnvironment?: Record<string, string | undefined>;
  linkedSecrets?: Array<{
    name: string;
    value: string;
  }>;
}

/** The variables an env file starts from, and how they are written. */
export interface EnvFileSource {
  content: string;
  variables: Record<string, string>;
}

export const envFileProvider: dynamic.ResourceProvider<ResolvedEnvFileInputs, ResolvedEnvFileInputs> = {
  async create(inputs) {
    await writeEnvironmentFile(inputs);

    return {
      id: `${inputs.secretPath ?? inputs.sourcePath ?? ''}:${inputs.envFilePath}`,
      outs: { ...inputs },
    };
  },

  async diff(_, olds, news) {
    return {
      changes: stableStringify(olds) !== stableStringify(news) || !(await matchesEnvironmentFile(news)),
    };
  },

  async update(_, __, news) {
    await writeEnvironmentFile(news);

    return {
      outs: { ...news },
    };
  },
};

/**
 * Writes the `.env` the images copy into the app: the env file or the
 * `RemoteEnvVault` it starts from, then the variables the package adds.
 * The images depend on it, so they are built after it is written.
 */
export class EnvFile extends dynamic.Resource {
  constructor(name: string, args: EnvFileInputs, opts?: CustomResourceOptions) {
    super(envFileProvider, `${name}.sst.aws.EnvFile`, args, opts);
  }
}

async function readSource(inputs: ResolvedEnvFileInputs): Promise<EnvFileSource> {
  if (inputs.secretPath) {
    const secrets = await pullSecretsFromAws(inputs.secretPath);

    if (!secrets) {
      throw new Error(`RemoteEnvVault secret not found at ${inputs.secretPath}.`);
    }

    return { content: toEnvFileContent(secrets), variables: secrets };
  }

  const fs = await import('node:fs');
  const content = inputs.sourcePath && fs.existsSync(inputs.sourcePath) ? fs.readFileSync(inputs.sourcePath, 'utf8') : '';

  return { content, variables: parseEnvFile(content) };
}

async function writeEnvironmentFile(inputs: ResolvedEnvFileInputs) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const content = buildEnvFileContent(await readSource(inputs), inputs);

  fs.mkdirSync(path.dirname(inputs.envFilePath), { recursive: true });
  fs.writeFileSync(inputs.envFilePath, content);
  fs.chmodSync(inputs.envFilePath, 0o600);
}

async function matchesEnvironmentFile(inputs: ResolvedEnvFileInputs) {
  const fs = await import('node:fs');

  if (!fs.existsSync(inputs.envFilePath)) {
    return false;
  }

  try {
    const expected = buildEnvFileContent(await readSource(inputs), inputs);

    return fs.readFileSync(inputs.envFilePath, 'utf8') === expected;
  } catch {
    return false;
  }
}

async function pullSecretsFromAws(secretPath: string): Promise<Record<string, string> | null> {
  const secretValue = await getSecretValue(secretPath);

  if (!secretValue) {
    return null;
  }

  const data = JSON.parse(secretValue);

  if (isChunkedSecret(data)) {
    return pullChunkedSecrets(secretPath, data.chunks);
  }

  return data;
}

async function pullChunkedSecrets(basePath: string, chunkCount: number): Promise<Record<string, string>> {
  const allVars: Record<string, string> = {};
  const chunkPromises = Array.from({ length: chunkCount }, (_, i) =>
    getSecretValue(getChunkPath(basePath, i + 1))
  );

  const chunkValues = await Promise.all(chunkPromises);

  for (let i = 0; i < chunkValues.length; i++) {
    const chunkValue = chunkValues[i];

    if (chunkValue) {
      Object.assign(allVars, JSON.parse(chunkValue));
    } else {
      console.warn(`Warning: Chunk ${i + 1} not found at ${getChunkPath(basePath, i + 1)}`);
    }
  }

  return allVars;
}

async function getSecretValue(secretPath: string): Promise<string | null> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});

  try {
    const response = await client.send(new GetSecretValueCommand({
      SecretId: secretPath,
    }));

    return response.SecretString || null;
  } catch (error) {
    if (isResourceNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function isChunkedSecret(data: any): data is { chunked: true; chunks: number } {
  return data && typeof data === 'object' && data.chunked === true && typeof data.chunks === 'number';
}

function isResourceNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'ResourceNotFoundException';
}

function getChunkPath(basePath: string, chunkIndex: number): string {
  return `${basePath}/${chunkIndex}`;
}

/**
 * The env file: the source as written, then the variables the package adds
 * (`APP_URL` and `LOG_CHANNEL` when the source has none, the linked
 * resources, and the linked secrets), unless `autoInject` is off. Laravel
 * reads the last value of a variable, so the linked resources' values win
 * over the same variables in the source.
 */
export function buildEnvFileContent(source: EnvFileSource, inputs: ResolvedEnvFileInputs): string {
  const content = source.content.replace(/\s+$/, '');

  if (inputs.autoInject === false) {
    return content + '\n';
  }

  const autoInjected: Record<string, string> = {};

  if (!hasOwnVariable(source.variables, 'APP_URL') && inputs.appUrl) {
    autoInjected.APP_URL = inputs.appUrl;
  }

  if (!hasOwnVariable(source.variables, 'LOG_CHANNEL')) {
    autoInjected.LOG_CHANNEL = 'stderr';
  }

  Object.entries(inputs.linkedEnvironment || {}).forEach(([key, value]) => {
    if (typeof value === 'string') {
      autoInjected[key] = value;
    }
  });

  (inputs.linkedSecrets || []).forEach((secret) => {
    autoInjected[secret.name] = secret.value;
  });

  if (Object.keys(autoInjected).length === 0) {
    return content + '\n';
  }

  return [content, '# --- SST-LARAVEL AUTO-INJECTED VARIABLES ---', toEnvFileContent(autoInjected)]
    .filter(Boolean)
    .join('\n\n') + '\n';
}

function hasOwnVariable(vars: Record<string, string>, key: string) {
  return Object.prototype.hasOwnProperty.call(vars, key);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((result, key) => {
        result[key] = sortValue((value as Record<string, unknown>)[key]);
        return result;
      }, {} as Record<string, unknown>);
  }

  return value;
}
