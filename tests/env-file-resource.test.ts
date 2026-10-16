import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { toEnvFileContent } from '../src/dotenv';

const aws = vi.hoisted(() => ({
  secrets: null as Record<string, string> | null,
  objects: new Map<string, { body: string; encryption: unknown; tags?: unknown }>(),
  multiline: null as { name: string; value: string; kmsKeyId?: string; versions: number } | null,
  deletedSecrets: [] as string[],
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

      if (name === 'CreateSecret') {
        aws.multiline = { name: input.Name, value: input.SecretString, kmsKeyId: input.KmsKeyId, versions: 1 };
        return { ARN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.Name}-AbCdEf`, VersionId: 'v1' };
      }

      if (name === 'PutSecretValue' || name === 'UpdateSecret') {
        if (!aws.multiline) {
          throw notFound('ResourceNotFoundException');
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
  PutSecretValueCommand: command('PutSecretValue'),
  UpdateSecretCommand: command('UpdateSecret'),
  DeleteSecretCommand: command('DeleteSecret'),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send({ name, input }: { name: string; input: any }) {
      if (name === 'PutObject') {
        aws.objects.set(input.Key, {
          body: input.Body,
          encryption: { ServerSideEncryption: input.ServerSideEncryption, SSEKMSKeyId: input.SSEKMSKeyId },
        });
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
        return { Contents: [...aws.objects.keys()].filter((key) => key.startsWith(input.Prefix)).map((Key) => ({ Key })) };
      }

      throw new Error(`unexpected ${name}`);
    }
  },
  PutObjectCommand: command('PutObject'),
  PutObjectTaggingCommand: command('PutObjectTagging'),
  ListObjectsV2Command: command('ListObjectsV2'),
}));

import { buildEnvFileContent, envFileProvider, ResolvedEnvFileInputs } from '../src/env-file-resource';

const HEADER = '# --- SST-LARAVEL AUTO-INJECTED VARIABLES ---';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-env-'));

beforeEach(() => {
  aws.secrets = null;
  aws.objects.clear();
  aws.multiline = null;
  aws.deletedSecrets = [];
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
  const storage = { bucket: 'env-bucket', region: 'us-east-1', partition: 'aws', secretName: '/app/production/sst-laravel/App/multiline-env' };
  const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

  function s3Inputs(source: string): ResolvedEnvFileInputs {
    const sourcePath = path.join(tempDir(), '.env.production');
    fs.writeFileSync(sourcePath, source);

    return {
      envFilePath: path.join(tempDir(), '.env'),
      sourcePath,
      fingerprint: 'f',
      appUrl: 'https://example.com',
      linkedEnvironment: { DB_PASSWORD: 'p$ss #1' },
      storage,
      runtimeEnvironment: {},
    };
  }

  const source = [
    'APP_KEY=base64:test',
    'APP_NAME="My App"',
    'VITE_APP_NAME="${APP_NAME}"',
    'PHP_MEMORY_LIMIT=1G',
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
      'APP_URL=https://example.com',
      'LOG_CHANNEL=stderr',
      'DB_PASSWORD=p$ss #1',
      'SST_LARAVEL_ENV_KEYS=APP_KEY,APP_NAME,VITE_APP_NAME,PASSPORT_PRIVATE_KEY,APP_URL,LOG_CHANNEL,DB_PASSWORD',
      '',
    ].join('\n');
    const key = `env/${sha256(expected)}.env`;

    expect(aws.objects.get(key)).toEqual({ body: expected, encryption: { ServerSideEncryption: 'AES256', SSEKMSKeyId: undefined } });
    expect(JSON.parse(aws.multiline!.value)).toEqual({ PASSPORT_PRIVATE_KEY: '-----BEGIN\nabc\n-----END' });
    expect(outs).toMatchObject({
      objectKey: key,
      objectArn: `arn:aws:s3:::env-bucket/${key}`,
      ssm: { PASSPORT_PRIVATE_KEY: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${storage.secretName}-AbCdEf:PASSPORT_PRIVATE_KEY::v1` },
      ignoredVariables: ['PHP_MEMORY_LIMIT'],
    });
    // Nothing is written for the images.
    expect(fs.existsSync(inputs.envFilePath)).toBe(false);
  });

  it('uploads a changed environment under a new name and lets the previous file expire', async () => {
    const first = s3Inputs(source);
    const { outs: olds } = await envFileProvider.create!(first);

    fs.writeFileSync(first.sourcePath!, source.replace('base64:test', 'base64:rotated'));
    const changed = { ...first, fingerprint: 'g' };

    expect((await envFileProvider.diff!('id', olds, changed)).changes).toBe(true);

    const { outs } = await envFileProvider.update!('id', olds, changed);

    expect(outs.objectKey).not.toBe(olds.objectKey);
    expect(aws.objects.get(olds.objectKey!)!.tags).toEqual([{ Key: 'sst-laravel-superseded', Value: 'true' }]);
    expect(aws.objects.get(outs.objectKey!)!.tags).toBeUndefined();
    // A new secret version, so the earlier task definition keeps its values.
    expect(outs.ssm!.PASSPORT_PRIVATE_KEY).toMatch(/::v2$/);
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
    const { outs } = await envFileProvider.create!(inputs);

    expect(aws.objects.get(outs.objectKey!)!.encryption).toEqual({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k' });
    expect(aws.multiline!.kmsKeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/k');
  });

  it('takes RemoteEnvVault values as they are, without expanding them', async () => {
    aws.secrets = { A: '${B}', B: 'x' };
    const { outs } = await envFileProvider.create!({ envFilePath: '/unused', secretPath: '/app/production/env', fingerprint: 'f', autoInject: false, storage });

    expect(aws.objects.get(outs.objectKey!)!.body).toBe('A=${B}\nB=x\nSST_LARAVEL_ENV_KEYS=A,B\n');
  });

  it('lets the files expire and schedules the secret for deletion when removed', async () => {
    const { outs } = await envFileProvider.create!(s3Inputs(source));

    await envFileProvider.delete!('id', outs);

    expect(aws.objects.get(outs.objectKey!)!.tags).toEqual([{ Key: 'sst-laravel-superseded', Value: 'true' }]);
    expect(aws.deletedSecrets).toEqual([`${outs.secretArn}:7`]);
  });
});
