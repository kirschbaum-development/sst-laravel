import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { loadEnvFile, toEnvFileContent } from '../src/dotenv';

const aws = vi.hoisted(() => ({
  secrets: null as Record<string, string> | null,
  objects: new Map<string, { body: string; encryption: unknown; tags?: Array<{ Key: string; Value: string }>; lastModified: Date }>(),
  multiline: null as { name: string; value: string; kmsKeyId?: string; versions: number; deleted?: boolean } | null,
  deletedSecrets: [] as string[],
  failSecretWrites: false,
}));
const vault = aws;

const command = (name: string) => class {
  readonly name = name;
  constructor(readonly input: any) {}
};

const notFound = (name: string) => Object.assign(new Error('not found'), { name });

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send({ name, input }: { name: string; input: any }) {
      if (name === 'GetSecretValue') {
        if (!aws.secrets) {
          throw notFound('ResourceNotFoundException');
        }

        return { SecretString: JSON.stringify(aws.secrets) };
      }

      if (aws.failSecretWrites && name !== 'DeleteSecret') {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      }

      if (name === 'DescribeSecret') {
        if (!aws.multiline) {
          throw notFound('ResourceNotFoundException');
        }

        return aws.multiline.deleted ? { DeletedDate: new Date() } : {};
      }

      if (name === 'CreateSecret') {
        aws.multiline = { name: input.Name, value: input.SecretString, kmsKeyId: input.KmsKeyId, versions: 1 };
        return { ARN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.Name}-AbCdEf`, VersionId: 'v1' };
      }

      if (name === 'RestoreSecret') {
        aws.multiline!.deleted = false;
        return {};
      }

      if (name === 'PutSecretValue' || name === 'UpdateSecret') {
        if (!aws.multiline || aws.multiline.deleted) {
          throw aws.multiline ? Object.assign(new Error('marked for deletion'), { name: 'InvalidRequestException' }) : notFound('ResourceNotFoundException');
        }

        if (name === 'UpdateSecret') {
          aws.multiline.kmsKeyId = input.KmsKeyId;
          return {};
        }

        aws.multiline.value = input.SecretString;
        aws.multiline.versions += 1;
        return { ARN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${aws.multiline.name}-AbCdEf`, VersionId: `v${aws.multiline.versions}` };
      }

      if (name === 'DeleteSecret') {
        aws.deletedSecrets.push(`${input.SecretId}:${input.RecoveryWindowInDays}`);
        return {};
      }

      throw new Error(`unexpected ${name}`);
    }
  },
  GetSecretValueCommand: command('GetSecretValue'),
  CreateSecretCommand: command('CreateSecret'),
  DescribeSecretCommand: command('DescribeSecret'),
  PutSecretValueCommand: command('PutSecretValue'),
  UpdateSecretCommand: command('UpdateSecret'),
  RestoreSecretCommand: command('RestoreSecret'),
  DeleteSecretCommand: command('DeleteSecret'),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send({ name, input }: { name: string; input: any }) {
      if (name === 'PutObject') {
        aws.objects.set(input.Key, {
          body: input.Body,
          encryption: { ServerSideEncryption: input.ServerSideEncryption, SSEKMSKeyId: input.SSEKMSKeyId },
          lastModified: new Date(),
        });
        return {};
      }

      if (name === 'GetObjectTagging') {
        return { TagSet: aws.objects.get(input.Key)?.tags ?? [] };
      }

      if (name === 'DeleteObject') {
        aws.objects.delete(input.Key);
        return {};
      }

      if (name === 'PutObjectTagging') {
        const object = aws.objects.get(input.Key);

        if (!object) {
          throw notFound('NoSuchKey');
        }

        object.tags = input.Tagging.TagSet;
        return {};
      }

      if (name === 'ListObjectsV2') {
        return {
          Contents: [...aws.objects.entries()]
            .filter(([key]) => key.startsWith(input.Prefix))
            .map(([Key, object]) => ({ Key, LastModified: object.lastModified })),
        };
      }

      throw new Error(`unexpected ${name}`);
    }
  },
  PutObjectCommand: command('PutObject'),
  PutObjectTaggingCommand: command('PutObjectTagging'),
  ListObjectsV2Command: command('ListObjectsV2'),
  GetObjectTaggingCommand: command('GetObjectTagging'),
  DeleteObjectCommand: command('DeleteObject'),
}));

import * as pulumi from '@pulumi/pulumi';
import { buildEnvFileContent, EnvFile, envFileProvider, ResolvedEnvFileInputs } from '../src/env-file-resource';

const HEADER = '# --- SST-LARAVEL AUTO-INJECTED VARIABLES ---';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-env-'));

beforeEach(() => {
  aws.secrets = null;
  aws.objects.clear();
  aws.multiline = null;
  aws.deletedSecrets = [];
  aws.failSecretWrites = false;
});

describe('buildEnvFileContent', () => {
  const file = (content: string) => ({ content, variables: {} as Record<string, string> });

  it('keeps the env file as written and adds the injected variables, quoted', () => {
    const source = 'APP_KEY=base64:test\n# Mail\nMAIL_FROM_NAME="${APP_NAME}"\n\n';

    expect(buildEnvFileContent(file(source), {
      envFilePath: '/x',
      fingerprint: 'f',
      appUrl: 'https://example.com',
      linkedEnvironment: { DB_PASSWORD: 'p$ss #1', DB_HOST: 'db', SKIPPED: undefined },
      linkedSecrets: [{ name: 'STRIPE_SECRET', value: "it's secret" }],
    })).toBe([
      'APP_KEY=base64:test\n# Mail\nMAIL_FROM_NAME="${APP_NAME}"',
      HEADER,
      'APP_URL=https://example.com\nDB_HOST=db\nDB_PASSWORD=\'p$ss #1\'\nLOG_CHANNEL=stderr\nSTRIPE_SECRET="it\'s secret"\n',
    ].join('\n\n'));
  });

  it('leaves APP_URL and LOG_CHANNEL to the source when it sets them', () => {
    const content = buildEnvFileContent(
      { content: 'APP_URL=https://app.test\nLOG_CHANNEL=daily\n', variables: { APP_URL: 'https://app.test', LOG_CHANNEL: 'daily' } },
      { envFilePath: '/x', fingerprint: 'f', appUrl: 'https://example.com' },
    );

    expect(content).toBe('APP_URL=https://app.test\nLOG_CHANNEL=daily\n');
  });

  it('adds the log formatter unless the source sets one, even to nothing', () => {
    const inputs = { envFilePath: '/x', fingerprint: 'f', logFormatter: 'Monolog\\Formatter\\JsonFormatter' };

    // Read back the way Laravel reads it: the backslashes survive.
    expect(loadEnvFile(buildEnvFileContent(file('APP_KEY=x'), inputs)).LOG_STDERR_FORMATTER).toBe('Monolog\\Formatter\\JsonFormatter');
    expect(buildEnvFileContent(
      { content: 'LOG_STDERR_FORMATTER=\n', variables: { LOG_STDERR_FORMATTER: '' } },
      inputs,
    )).not.toContain('Monolog');
  });

  it('writes the source alone when autoInject is off', () => {
    expect(buildEnvFileContent(file('APP_KEY=x'), { envFilePath: '/x', fingerprint: 'f', autoInject: false, appUrl: 'https://example.com' }))
      .toBe('APP_KEY=x\n');
  });

  it('writes a RemoteEnvVault the way earlier versions did, so images are not rebuilt', () => {
    const secrets = { APP_KEY: 'base64:test', REDIS_PASSWORD: 'a$b' };

    expect(buildEnvFileContent(
      { content: toEnvFileContent(secrets), variables: secrets },
      { envFilePath: '/x', fingerprint: 'f', linkedEnvironment: { DB_HOST: 'db' } },
    )).toBe(`APP_KEY=base64:test\nREDIS_PASSWORD='a$b'\n\n${HEADER}\n\nDB_HOST=db\nLOG_CHANNEL=stderr\n`);
  });
});

describe('envFileProvider', () => {
  function fileInputs(): ResolvedEnvFileInputs {
    const dir = tempDir();
    const sourcePath = path.join(dir, '.env.production');
    fs.writeFileSync(sourcePath, 'APP_KEY=base64:test\n');

    return { envFilePath: path.join(dir, 'build/deploy/.env'), sourcePath, fingerprint: 'f', linkedEnvironment: { DB_HOST: 'db' } };
  }

  it('writes the env file, readable by its owner only', async () => {
    const inputs = fileInputs();

    await envFileProvider.create!(inputs);

    expect(fs.readFileSync(inputs.envFilePath, 'utf-8')).toBe(`APP_KEY=base64:test\n\n${HEADER}\n\nDB_HOST=db\nLOG_CHANNEL=stderr\n`);
    expect(fs.statSync(inputs.envFilePath).mode & 0o777).toBe(0o600);
  });

  it('rewrites the file when it is missing or differs, as in a fresh CI checkout', async () => {
    const inputs = fileInputs();
    await envFileProvider.create!(inputs);

    expect((await envFileProvider.diff!('id', inputs, inputs)).changes).toBe(false);

    fs.rmSync(inputs.envFilePath);
    expect((await envFileProvider.diff!('id', inputs, inputs)).changes).toBe(true);

    await envFileProvider.update!('id', inputs, inputs);
    fs.appendFileSync(inputs.sourcePath!, 'APP_DEBUG=false\n');
    expect((await envFileProvider.diff!('id', inputs, inputs)).changes).toBe(true);
  });

  it('starts from the RemoteEnvVault secrets', async () => {
    vault.secrets = { APP_KEY: 'base64:vault' };
    const envFilePath = path.join(tempDir(), '.env');

    await envFileProvider.create!({ envFilePath, secretPath: '/app/production/env', fingerprint: 'f', autoInject: false });

    expect(fs.readFileSync(envFilePath, 'utf-8')).toBe('APP_KEY=base64:vault\n');
  });

  it('fails the deploy when the RemoteEnvVault secret is missing', async () => {
    await expect(envFileProvider.create!({ envFilePath: path.join(tempDir(), '.env'), secretPath: '/app/production/env', fingerprint: 'f' }))
      .rejects.toThrow('RemoteEnvVault secret not found at /app/production/env.');
  });
});

describe('envFileProvider with storage', () => {
  const storage = { bucket: 'env-bucket', region: 'us-east-1', partition: 'aws', secretName: '/app/production/sst-laravel/App/multiline-env/App-EnvFile' };
  const days = (count: number) => new Date(Date.now() - count * 24 * 60 * 60 * 1000);
  const supersededAt = (key: string) => aws.objects.get(key)!.tags?.find((tag) => tag.Key === 'sst-laravel-superseded-at')?.Value;

  function s3Inputs(source: string, objectKey = 'env/first.env'): ResolvedEnvFileInputs {
    const sourcePath = path.join(tempDir(), '.env.production');
    fs.writeFileSync(sourcePath, source);

    return {
      envFilePath: path.join(tempDir(), '.env'),
      sourcePath,
      fingerprint: 'f',
      appUrl: 'https://example.com',
      linkedEnvironment: { DB_PASSWORD: 'p$ss #1' },
      storage,
      objectKey,
      runtimeEnvironment: {},
    };
  }

  const source = [
    'APP_KEY=base64:test',
    'APP_NAME="My App"',
    'VITE_APP_NAME="${APP_NAME}"',
    'PHP_MEMORY_LIMIT=1G',
    'SSL_CA=/etc/ssl/rds.pem',
    'MAIL_PASSWORD=',
    'PASSPORT_PRIVATE_KEY="-----BEGIN',
    'abc',
    '-----END"',
  ].join('\n');

  it('uploads the variables Laravel would load as plain lines, and the multi-line ones to a versioned secret', async () => {
    const inputs = s3Inputs(source);
    const { outs } = await envFileProvider.create!(inputs);

    const expected = [
      'APP_KEY=base64:test',
      'APP_NAME=My App',
      'VITE_APP_NAME=My App',
      'SSL_CA=/etc/ssl/rds.pem',
      'MAIL_PASSWORD=',
      'APP_URL=https://example.com',
      'LOG_CHANNEL=stderr',
      'DB_PASSWORD=p$ss #1',
      // Lists MAIL_PASSWORD too, which ECS leaves out for being empty.
      'SST_LARAVEL_ENV_KEYS=APP_KEY,APP_NAME,VITE_APP_NAME,SSL_CA,MAIL_PASSWORD,PASSPORT_PRIVATE_KEY,APP_URL,LOG_CHANNEL,DB_PASSWORD',
      '',
    ].join('\n');

    expect(aws.objects.get('env/first.env')).toMatchObject({ body: expected, encryption: { ServerSideEncryption: 'AES256', SSEKMSKeyId: undefined } });
    expect(JSON.parse(aws.multiline!.value)).toEqual({ PASSPORT_PRIVATE_KEY: '-----BEGIN\nabc\n-----END' });
    expect(outs).toMatchObject({
      ssm: { PASSPORT_PRIVATE_KEY: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${storage.secretName}-AbCdEf:PASSPORT_PRIVATE_KEY::v1` },
      ignoredVariables: ['PHP_MEMORY_LIMIT'],
    });
    // Nothing is written for the images.
    expect(fs.existsSync(inputs.envFilePath)).toBe(false);
  });

  it('uploads a changed environment to its new key, then marks the previous file as replaced', async () => {
    const first = s3Inputs(source);
    const { outs: olds } = await envFileProvider.create!(first);

    fs.writeFileSync(first.sourcePath!, source.replace('base64:test', 'base64:rotated'));
    const changed = { ...first, fingerprint: 'g', objectKey: 'env/second.env' };

    expect((await envFileProvider.diff!('id', olds, changed)).changes).toBe(true);

    const before = Date.now();
    const { outs } = await envFileProvider.update!('id', olds, changed);

    expect(aws.objects.get('env/second.env')!.body).toContain('APP_KEY=base64:rotated');
    expect(Date.parse(supersededAt('env/first.env')!)).toBeGreaterThanOrEqual(before);
    expect(aws.objects.get('env/second.env')!.tags).toBeUndefined();
    // A new secret version, so the earlier task definition keeps its values.
    expect(outs.ssm!.PASSPORT_PRIVATE_KEY).toMatch(/::v2$/);
  });

  it('leaves the previous file alone when the update fails', async () => {
    const first = s3Inputs(source);
    const { outs: olds } = await envFileProvider.create!(first);

    aws.failSecretWrites = true;

    await expect(envFileProvider.update!('id', olds, { ...first, fingerprint: 'g', objectKey: 'env/second.env' })).rejects.toThrow('denied');
    expect(aws.objects.get('env/first.env')!.tags).toBeUndefined();
  });

  it('deletes the files replaced more than 30 days ago, counting from when they were replaced', async () => {
    const put = (key: string, uploaded: number, replaced?: number) => aws.objects.set(key, {
      body: '',
      encryption: {},
      lastModified: days(uploaded),
      ...(replaced === undefined ? {} : { tags: [{ Key: 'sst-laravel-superseded-at', Value: days(replaced).toISOString() }] }),
    });

    put('env/expired.env', 90, 31);
    put('env/replaced-recently.env', 90, 29);
    put('env/old-but-current-elsewhere.env', 90);

    await envFileProvider.create!(s3Inputs('APP_KEY=x'));

    expect([...aws.objects.keys()].sort()).toEqual(['env/first.env', 'env/old-but-current-elsewhere.env', 'env/replaced-recently.env']);
  });

  it('returns outputs the dynamic provider host can send, with or without values that span lines', async () => {
    // How the host sends them to the engine (@pulumi/pulumi cmd/dynamic-provider).
    const pulumiRequire = createRequire(createRequire(import.meta.url).resolve('@pulumi/pulumi'));
    const { Struct } = pulumiRequire('google-protobuf/google/protobuf/struct_pb');
    const send = (outs: unknown) => Struct.fromJavaScript(outs).toJavaScript();

    const singleLine = s3Inputs('APP_KEY=base64:x');
    const { outs: created } = await envFileProvider.create!(singleLine);
    expect(created.secretArn).toBeUndefined();
    expect(send(created)).toMatchObject({ ssm: {}, objectKey: 'env/first.env' });

    aws.secrets = { APP_KEY: 'base64:vault' };
    const vault = { envFilePath: '/unused', secretPath: '/app/production/env', fingerprint: 'f', storage, objectKey: 'env/vault.env' };
    expect(send((await envFileProvider.create!(vault)).outs)).toMatchObject({ ssm: {} });

    // From values that span lines to none: the secret is kept for its ARN.
    const { outs: multiline } = await envFileProvider.create!(s3Inputs(source, 'env/multi.env'));
    const { outs: updated } = await envFileProvider.update!('id', multiline, { ...singleLine, objectKey: 'env/second.env' });
    expect(send(updated)).toMatchObject({ ssm: {}, secretArn: multiline.secretArn });
  });

  it('re-uploads when the file is gone, and leaves an unchanged environment alone', async () => {
    const inputs = s3Inputs('APP_KEY=x');
    const { outs } = await envFileProvider.create!(inputs);

    expect((await envFileProvider.diff!('id', outs, inputs)).changes).toBe(false);

    aws.objects.clear();
    expect((await envFileProvider.diff!('id', outs, inputs)).changes).toBe(true);
  });

  it('encrypts with the KMS key when there is one', async () => {
    const inputs = { ...s3Inputs(source), storage: { ...storage, kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/k' } };
    await envFileProvider.create!(inputs);

    expect(aws.objects.get('env/first.env')!.encryption).toEqual({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k' });
    expect(aws.multiline!.kmsKeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/k');
  });

  it('brings back a secret still in its recovery window', async () => {
    const { outs } = await envFileProvider.create!(s3Inputs(source));
    await envFileProvider.delete!('id', outs);
    aws.multiline!.deleted = true;

    const { outs: again } = await envFileProvider.create!(s3Inputs(source));

    expect(aws.multiline!.deleted).toBe(false);
    expect(again.ssm!.PASSPORT_PRIVATE_KEY).toMatch(/::v2$/);
  });

  it('takes RemoteEnvVault values as they are, without expanding them', async () => {
    aws.secrets = { A: '${B}', B: 'x' };
    await envFileProvider.create!({ envFilePath: '/unused', secretPath: '/app/production/env', fingerprint: 'f', autoInject: false, storage, objectKey: 'env/vault.env' });

    expect(aws.objects.get('env/vault.env')!.body).toBe('A=${B}\nB=x\nSST_LARAVEL_ENV_KEYS=A,B\n');
  });

  it('marks the file as replaced and schedules its own secret for deletion when removed', async () => {
    const { outs } = await envFileProvider.create!(s3Inputs(source));

    await envFileProvider.delete!('id', outs);

    expect(supersededAt('env/first.env')).toBeDefined();
    expect(aws.deletedSecrets).toEqual([`${outs.secretArn}:7`]);
  });
});

describe('EnvFile', () => {
  it('exposes the outputs the provider returns', async () => {
    const ssm = { PRIVATE_KEY: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s-AbCdEf:PRIVATE_KEY::v1' };
    // Vite's module transform keeps Pulumi from serializing the provider.
    const closure = createRequire(import.meta.url)('@pulumi/pulumi/runtime/closure/serializeClosure');
    vi.spyOn(closure, 'serializeFunction').mockResolvedValue({ text: '', containsSecrets: false });
    pulumi.runtime.setMocks({
      newResource: (args) => ({ id: 'env', state: { ...args.inputs, ssm, ignoredVariables: ['PHP_MEMORY_LIMIT'] } }),
      call: (args) => args.inputs,
    });

    const envFile = new EnvFile('App-EnvFile', { envFilePath: '/unused', fingerprint: 'f' });
    const value = <T>(output: pulumi.Output<T>) => new Promise<T>((resolve) => output.apply(resolve));

    // A class field would reset them after Pulumi sets them.
    expect(await value(envFile.ssm)).toEqual(ssm);
    expect(await value(envFile.ignoredVariables)).toEqual(['PHP_MEMORY_LIMIT']);
  });
});
