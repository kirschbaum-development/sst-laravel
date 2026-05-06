import { CustomResourceOptions, Input, dynamic } from '@pulumi/pulumi';

export interface RemoteEnvFileLinkedSecret {
  name: Input<string>;
  value: Input<string>;
}

export interface RemoteEnvFileInputs {
  secretPath: Input<string>;
  envFilePath: Input<string>;
  fingerprint: Input<string>;
  autoInject?: Input<boolean>;
  appUrl?: Input<string | undefined>;
  linkedEnvironment?: Input<Record<string, Input<string | undefined> | undefined>>;
  linkedSecrets?: Input<RemoteEnvFileLinkedSecret[]>;
}

interface ResolvedRemoteEnvFileInputs {
  secretPath: string;
  envFilePath: string;
  fingerprint: string;
  autoInject?: boolean;
  appUrl?: string;
  linkedEnvironment?: Record<string, string | undefined>;
  linkedSecrets?: Array<{
    name: string;
    value: string;
  }>;
}

const provider: dynamic.ResourceProvider<ResolvedRemoteEnvFileInputs, ResolvedRemoteEnvFileInputs> = {
  async create(inputs) {
    const outs = await writeRemoteEnvironmentFile(inputs);

    return {
      id: `${inputs.secretPath}:${inputs.envFilePath}`,
      outs,
    };
  },

  async diff(_, olds, news) {
    return {
      changes:
        stableStringify(olds) !== stableStringify(news) ||
        !(await matchesEnvironmentFile(news)),
    };
  },

  async update(_, __, news) {
    const outs = await writeRemoteEnvironmentFile(news);

    return {
      outs,
    };
  },
};

export class RemoteEnvFile extends dynamic.Resource {
  constructor(
    name: string,
    args: RemoteEnvFileInputs,
    opts?: CustomResourceOptions,
  ) {
    super(provider, `${name}.sst.aws.RemoteEnvFile`, args, opts);
  }
}

async function writeRemoteEnvironmentFile(inputs: ResolvedRemoteEnvFileInputs) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const secrets = await pullSecretsFromAws(inputs.secretPath);

  if (!secrets) {
    throw new Error(`RemoteEnvVault secret not found at ${inputs.secretPath}.`);
  }

  const envContent = buildEnvFileContent(secrets, inputs);

  fs.mkdirSync(path.dirname(inputs.envFilePath), { recursive: true });
  fs.writeFileSync(inputs.envFilePath, envContent + '\n');
  fs.chmodSync(inputs.envFilePath, 0o755);

  return {
    ...inputs,
  };
}

async function matchesEnvironmentFile(inputs: ResolvedRemoteEnvFileInputs) {
  const fs = await import('node:fs');

  if (!fs.existsSync(inputs.envFilePath)) {
    return false;
  }

  const secrets = await pullSecretsFromAws(inputs.secretPath);

  if (!secrets) {
    return false;
  }

  const expected = buildEnvFileContent(secrets, inputs) + '\n';
  const actual = fs.readFileSync(inputs.envFilePath, 'utf8');

  return actual === expected;
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

function buildEnvFileContent(
  secrets: Record<string, string>,
  inputs: ResolvedRemoteEnvFileInputs,
) {
  const baseEnv = toEnvFileContent(secrets);

  if (inputs.autoInject === false) {
    return baseEnv;
  }

  const autoInjected: Record<string, string> = {};

  if (!hasOwnVariable(secrets, 'APP_URL') && inputs.appUrl) {
    autoInjected.APP_URL = inputs.appUrl;
  }

  if (!hasOwnVariable(secrets, 'LOG_CHANNEL')) {
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
    return baseEnv;
  }

  return [
    baseEnv,
    '# --- SST-LARAVEL AUTO-INJECTED VARIABLES ---',
    toEnvFileContent(autoInjected),
  ].filter(Boolean).join('\n\n');
}

export function toEnvFileContent(vars: Record<string, string>): string {
  const sortedKeys = Object.keys(vars).sort();

  return sortedKeys
    .map((key) => {
      const value = vars[key];
      const needsQuoting =
        value.includes(' ') ||
        value.includes('"') ||
        value.includes("'") ||
        value.includes('\n') ||
        value.includes('$') ||
        value.includes('\\') ||
        value.includes('#');

      if (!needsQuoting) {
        return `${key}=${value}`;
      }

      // Single quotes are phpdotenv "raw literal" mode — no $ expansion, no escapes.
      // Use them whenever possible so randomly-generated secrets round-trip safely.
      if (!value.includes("'") && !value.includes('\n')) {
        return `${key}='${value}'`;
      }

      // Fall back to double quotes when the value itself contains a single quote
      // or newline. Escape \, $, and " so phpdotenv reads the literal value.
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/\$/g, '\\$')
        .replace(/"/g, '\\"');
      return `${key}="${escaped}"`;
    })
    .join('\n');
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
