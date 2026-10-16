import { CustomResourceOptions, Input, Output, dynamic } from '@pulumi/pulumi';
import { loadEnvFile, parseEnvFile, toEcsEnvFileContent, toEnvFileContent } from './dotenv.js';

// The provider runs in Pulumi's dynamic provider host, which gets it
// serialized: everything it uses must be in this file or in `./dotenv`, and
// modules are imported inside the functions.

/** Where the containers get their variables from, instead of an image file. */
export interface EnvFileStorage {
  /** The bucket the env files are uploaded to. */
  bucket: string;
  region: string;
  partition: string;
  /** The customer-managed key that encrypts the env file and the secret. */
  kmsKeyArn?: string;
  /** The Secrets Manager secret that holds the values that span lines. */
  secretName: string;
}

export interface EnvFileInputs {
  /** Where to write the env file, when the images copy it. */
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
  /** Upload the variables for ECS instead of writing the file the images copy. */
  storage?: Input<EnvFileStorage>;
  /** The containers' own variables, which `${VAR}` in the env file can read. */
  runtimeEnvironment?: Input<Record<string, Input<string>>>;
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
  storage?: EnvFileStorage;
  runtimeEnvironment?: Record<string, string>;
}

export interface EnvFileOutputs extends ResolvedEnvFileInputs {
  /** The uploaded env file, for `environmentFiles`. */
  objectArn?: string;
  objectKey?: string;
  /** The values that span lines, as `ssm` references to `secretArn`. */
  ssm?: Record<string, string>;
  secretArn?: string;
  /** Variables left out because the images set them. */
  ignoredVariables?: string[];
}

const OUTPUT_KEYS = ['objectArn', 'objectKey', 'ssm', 'secretArn', 'ignoredVariables'];

/** The tag that lets the bucket's lifecycle rule expire an env file. */
export const SUPERSEDED_TAG = 'sst-laravel-superseded';

/** Lists the variables of the env file, so the container can write its `.env`. */
export const ENV_KEYS_VARIABLE = 'SST_LARAVEL_ENV_KEYS';

/**
 * Variables the ServerSideUp images or the package's Dockerfiles set. Laravel
 * never lets an `.env` override them, but ECS would, so they stay out of the
 * uploaded env file. Set them in `config.environment.vars` instead.
 */
const IMAGE_VARIABLES = [
  'APP_BASE_DIR', 'COMPOSER_ALLOW_SUPERUSER', 'COMPOSER_HOME', 'COMPOSER_MAX_PARALLEL_HTTP', 'CONTAINER_TYPE',
  'DISABLE_DEFAULT_CONFIG', 'GPG_KEYS', 'HEALTHCHECK_PATH', 'HOME', 'HOSTNAME', 'LOG_OUTPUT_LEVEL', 'PATH',
  'PHPIZE_DEPS', 'PHP_ASC_URL', 'PHP_CFLAGS', 'PHP_CPPFLAGS', 'PHP_DATE_TIMEZONE', 'PHP_DISABLE_FUNCTIONS',
  'PHP_DISPLAY_ERRORS', 'PHP_DISPLAY_STARTUP_ERRORS', 'PHP_ERROR_LOG', 'PHP_ERROR_REPORTING', 'PHP_FILE_UPLOADS',
  'PHP_HTML_ERRORS', 'PHP_INI_DIR', 'PHP_LDFLAGS', 'PHP_MAX_EXECUTION_TIME', 'PHP_MAX_FILE_UPLOADS',
  'PHP_MAX_INPUT_TIME', 'PHP_MAX_INPUT_VARS', 'PHP_MEMORY_LIMIT', 'PHP_OPEN_BASEDIR', 'PHP_POST_MAX_SIZE',
  'PHP_REALPATH_CACHE_SIZE', 'PHP_REALPATH_CACHE_TTL', 'PHP_SESSION_COOKIE_HTTPONLY', 'PHP_SESSION_COOKIE_SECURE',
  'PHP_SHA256', 'PHP_UPLOAD_MAX_FILE_SIZE', 'PHP_URL', 'PHP_VERSION', 'PHP_ZEND_DETECT_UNICODE',
  'PHP_ZEND_MULTIBYTE', 'SHOW_WELCOME_MESSAGE', 'TRUSTED_PROXY', ENV_KEYS_VARIABLE,
];

const IMAGE_VARIABLE_PREFIXES = ['AUTORUN_', 'NGINX_', 'PHP_FPM_', 'PHP_OPCACHE_', 'S6_', 'SSL_'];

export function isImageVariable(name: string): boolean {
  return IMAGE_VARIABLES.includes(name) || IMAGE_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export const envFileProvider: dynamic.ResourceProvider<ResolvedEnvFileInputs, EnvFileOutputs> = {
  async create(inputs) {
    return {
      id: `${inputs.secretPath ?? inputs.sourcePath ?? ''}:${inputs.envFilePath}`,
      outs: await writeEnvironment(inputs),
    };
  },

  async diff(_, olds, news) {
    if (stableStringify(withoutOutputs(olds)) !== stableStringify(news)) {
      return { changes: true };
    }

    return { changes: !(news.storage ? await envFileObjectExists(olds) : await matchesEnvironmentFile(news)) };
  },

  async update(_, olds, news) {
    return { outs: await writeEnvironment(news, olds) };
  },

  async delete(_, olds) {
    if (olds.storage && olds.objectKey) {
      await markSuperseded(olds.storage, olds.objectKey);
    }

    if (olds.storage && olds.secretArn) {
      await deleteMultilineSecret(olds.storage, olds.secretArn);
    }
  },
};

/**
 * Writes the variables the containers get: the env file or the
 * `RemoteEnvVault` it starts from, then the variables the package adds.
 * With `storage`, they are uploaded for ECS to set when a container starts.
 * Otherwise they are written to the `.env` the images copy. The images
 * depend on it, so they are built after it is written.
 */
export class EnvFile extends dynamic.Resource {
  /** The env file in S3, for the services' `environmentFiles`. */
  public readonly objectArn!: Output<string | undefined>;
  /** The values that span lines, for the services' `ssm`. */
  public readonly ssm!: Output<Record<string, string> | undefined>;
  /** Variables of the env file left out because the images set them. */
  public readonly ignoredVariables!: Output<string[] | undefined>;

  constructor(name: string, args: EnvFileInputs, opts?: CustomResourceOptions) {
    super(
      envFileProvider,
      `${name}.sst.aws.EnvFile`,
      { ...args, objectArn: undefined, ssm: undefined, ignoredVariables: undefined },
      opts,
    );
  }
}

async function writeEnvironment(inputs: ResolvedEnvFileInputs, olds?: EnvFileOutputs): Promise<EnvFileOutputs> {
  if (!inputs.storage) {
    await writeEnvironmentFile(inputs);

    if (olds?.storage && olds.secretArn) {
      await deleteMultilineSecret(olds.storage, olds.secretArn);
    }

    return { ...inputs };
  }

  return { ...inputs, ...(await uploadEnvironment(inputs, inputs.storage, olds)) };
}

async function readSource(inputs: ResolvedEnvFileInputs): Promise<EnvFileSource> {
  if (inputs.secretPath) {
    const secrets = await pullSecretsFromAws(inputs.secretPath, inputs.storage?.region);

    if (!secrets) {
      throw new Error(`RemoteEnvVault secret not found at ${inputs.secretPath}.`);
    }

    return { content: toEnvFileContent(secrets), variables: secrets };
  }

  const fs = await import('node:fs');
  const content = inputs.sourcePath && fs.existsSync(inputs.sourcePath) ? fs.readFileSync(inputs.sourcePath, 'utf8') : '';

  return { content, variables: parseEnvFile(content) };
}

/** The variables an env file starts from, and how they are written. */
export interface EnvFileSource {
  content: string;
  variables: Record<string, string>;
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

/**
 * Uploads the variables as an env file named after its content, so a change
 * gives the services a new task definition, and an earlier one stays
 * available to roll back to until the bucket's lifecycle rule expires it.
 * Values that span lines go to a Secrets Manager secret, referenced by
 * version for the same reason.
 */
async function uploadEnvironment(
  inputs: ResolvedEnvFileInputs,
  storage: EnvFileStorage,
  olds?: EnvFileOutputs,
): Promise<Pick<EnvFileOutputs, 'objectArn' | 'objectKey' | 'ssm' | 'secretArn' | 'ignoredVariables'>> {
  const { createHash } = await import('node:crypto');
  const { variables, ignoredVariables } = buildContainerVariables(await readSource(inputs), inputs);
  const plain: Record<string, string> = {};
  const multiline: Record<string, string> = {};

  for (const [key, value] of Object.entries(variables)) {
    (/[\r\n]/.test(value) ? multiline : plain)[key] = value;
  }

  plain[ENV_KEYS_VARIABLE] = Object.keys(variables).join(',');

  const content = toEcsEnvFileContent(plain);
  const objectKey = `env/${createHash('sha256').update(content).digest('hex')}.env`;
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  await new S3Client({ region: storage.region }).send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: objectKey,
    Body: content,
    ContentType: 'text/plain',
    ...(storage.kmsKeyArn
      ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: storage.kmsKeyArn }
      : { ServerSideEncryption: 'AES256' as const }),
  }));

  if (olds?.storage?.bucket === storage.bucket && olds.objectKey && olds.objectKey !== objectKey) {
    await markSuperseded(storage, olds.objectKey);
  }

  const secret = Object.keys(multiline).length > 0
    ? await putMultilineSecret(storage, multiline, olds?.storage?.kmsKeyArn !== storage.kmsKeyArn)
    : undefined;

  return {
    objectArn: `arn:${storage.partition}:s3:::${storage.bucket}/${objectKey}`,
    objectKey,
    ssm: secret
      ? Object.fromEntries(Object.keys(multiline).map((key) => [key, `${secret.arn}:${key}::${secret.versionId}`]))
      : {},
    secretArn: secret?.arn ?? (olds?.storage ? olds.secretArn : undefined),
    ignoredVariables,
  };
}

/**
 * The variables Laravel gets from the env file, for ECS to set: the source
 * as Laravel loads it, then the variables the package adds (see
 * `buildEnvFileContent`), without the ones the images set.
 */
export function buildContainerVariables(
  source: EnvFileSource,
  inputs: ResolvedEnvFileInputs,
): { variables: Record<string, string>; ignoredVariables: string[] } {
  // A RemoteEnvVault has the values themselves, a file has to be loaded.
  const loaded = inputs.secretPath
    ? { ...source.variables }
    : loadEnvFile(source.content, inputs.runtimeEnvironment);
  const all = inputs.autoInject === false ? loaded : { ...loaded, ...buildAutoInjectedVariables(loaded, inputs) };
  const variables: Record<string, string> = {};
  const ignoredVariables: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (isImageVariable(key)) {
      ignoredVariables.push(key);
    } else {
      variables[key] = value;
    }
  }

  return { variables, ignoredVariables };
}

async function markSuperseded(storage: EnvFileStorage, objectKey: string) {
  const { S3Client, PutObjectTaggingCommand } = await import('@aws-sdk/client-s3');

  try {
    await new S3Client({ region: storage.region }).send(new PutObjectTaggingCommand({
      Bucket: storage.bucket,
      Key: objectKey,
      Tagging: { TagSet: [{ Key: SUPERSEDED_TAG, Value: 'true' }] },
    }));
  } catch (error) {
    // Already gone: expired, or removed with its bucket.
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

async function envFileObjectExists(outputs: EnvFileOutputs) {
  if (!outputs.storage || !outputs.objectKey) {
    return false;
  }

  // Listing, since the bucket policy denies reading the file to the deploy.
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const response = await new S3Client({ region: outputs.storage.region }).send(new ListObjectsV2Command({
    Bucket: outputs.storage.bucket,
    Prefix: outputs.objectKey,
    MaxKeys: 1,
  }));

  return (response.Contents ?? []).some((object) => object.Key === outputs.objectKey);
}

async function putMultilineSecret(storage: EnvFileStorage, values: Record<string, string>, keyChanged: boolean) {
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand, UpdateSecretCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({ region: storage.region });
  const secretString = JSON.stringify(values);

  try {
    if (keyChanged) {
      await client.send(new UpdateSecretCommand({
        SecretId: storage.secretName,
        KmsKeyId: storage.kmsKeyArn ?? 'alias/aws/secretsmanager',
      }));
    }

    const response = await client.send(new PutSecretValueCommand({ SecretId: storage.secretName, SecretString: secretString }));

    return { arn: response.ARN!, versionId: response.VersionId! };
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  const response = await client.send(new CreateSecretCommand({
    Name: storage.secretName,
    Description: 'The environment variables of a Laravel app that span lines (sst-laravel).',
    SecretString: secretString,
    ...(storage.kmsKeyArn ? { KmsKeyId: storage.kmsKeyArn } : {}),
  }));

  return { arn: response.ARN!, versionId: response.VersionId! };
}

async function deleteMultilineSecret(storage: EnvFileStorage, secretArn: string) {
  const { SecretsManagerClient, DeleteSecretCommand } = await import('@aws-sdk/client-secrets-manager');

  try {
    // The shortest recovery window, in case it is still needed after all.
    await new SecretsManagerClient({ region: storage.region }).send(
      new DeleteSecretCommand({ SecretId: secretArn, RecoveryWindowInDays: 7 }),
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

async function pullSecretsFromAws(secretPath: string, region?: string): Promise<Record<string, string> | null> {
  const secretValue = await getSecretValue(secretPath, region);

  if (!secretValue) {
    return null;
  }

  const data = JSON.parse(secretValue);

  if (isChunkedSecret(data)) {
    return pullChunkedSecrets(secretPath, data.chunks, region);
  }

  return data;
}

async function pullChunkedSecrets(basePath: string, chunkCount: number, region?: string): Promise<Record<string, string>> {
  const allVars: Record<string, string> = {};
  const chunkPromises = Array.from({ length: chunkCount }, (_, i) =>
    getSecretValue(getChunkPath(basePath, i + 1), region)
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

async function getSecretValue(secretPath: string, region?: string): Promise<string | null> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient(region ? { region } : {});

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

function isNotFound(error: unknown): boolean {
  return isResourceNotFound(error) || (!!error && typeof error === 'object' && 'name' in error
    && (error.name === 'NoSuchKey' || error.name === 'NoSuchBucket' || error.name === 'NotFound'));
}

function getChunkPath(basePath: string, chunkIndex: number): string {
  return `${basePath}/${chunkIndex}`;
}

/**
 * The variables the package adds to the source: `APP_URL` and `LOG_CHANNEL`
 * when the source has none, the linked resources, and the linked secrets.
 */
function buildAutoInjectedVariables(sourceVariables: Record<string, string>, inputs: ResolvedEnvFileInputs) {
  const autoInjected: Record<string, string> = {};

  if (!hasOwnVariable(sourceVariables, 'APP_URL') && inputs.appUrl) {
    autoInjected.APP_URL = inputs.appUrl;
  }

  if (!hasOwnVariable(sourceVariables, 'LOG_CHANNEL')) {
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

  return autoInjected;
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

  const autoInjected = buildAutoInjectedVariables(source.variables, inputs);

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

function withoutOutputs(outputs: EnvFileOutputs): ResolvedEnvFileInputs {
  return Object.fromEntries(
    Object.entries(outputs).filter(([key]) => !OUTPUT_KEYS.includes(key)),
  ) as ResolvedEnvFileInputs;
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
