import { all, ComponentResource, Input, Output, Resource } from '@pulumi/pulumi';
import { SUPERSEDED_TAG } from './env-file-resource';

/** Days an env file is kept after a deploy replaces it, to roll back to. */
export const SUPERSEDED_ENV_FILE_DAYS = 30;

/**
 * The bucket policy of the env files: only the services' execution roles,
 * which ECS reads the file with when a container starts, may read them.
 * Everyone else is denied, even with a broad read permission such as
 * `ReadOnlyAccess`. The deploy only writes and lists. Like the buckets SST
 * creates, requests over plain HTTP are denied.
 */
export function buildEnvBucketPolicy({ bucketArn, readerArns }: { bucketArn: string; readerArns: string[] }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyReadsExceptTheServices',
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: `${bucketArn}/*`,
        Condition: { ArnNotEquals: { 'aws:PrincipalArn': readerArns } },
      },
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ],
  };
}

/**
 * What the services' execution roles need to read their environment: every
 * env file, so a rollback to an earlier task definition still finds its
 * own, and the secret with the values that span lines. SST only grants the
 * current env file, and nothing to an execution role the app brings.
 */
export function buildEnvReadPolicy({ bucketArn, secretArn }: { bucketArn: string; secretArn: string }) {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'ReadEnvFiles', Effect: 'Allow', Action: 's3:GetObject', Resource: `${bucketArn}/env/*` },
      { Sid: 'ReadMultilineValues', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretArn },
    ],
  };
}

export interface EnvKeyPolicyOptions {
  accountId: string;
  partition: string;
  region: string;
  readerArns: string[];
}

/**
 * The policy of the key that encrypts the env file and the secret with the
 * values that span lines. The account keeps managing the key and can
 * encrypt with it, so the deploy can upload, but only the services'
 * execution roles can decrypt, and only through S3 and Secrets Manager.
 */
export function buildEnvKeyPolicy({ accountId, partition, region, readerArns }: EnvKeyPolicyOptions) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AccountManagesTheKeyButCannotDecrypt',
        Effect: 'Allow',
        Principal: { AWS: `arn:${partition}:iam::${accountId}:root` },
        NotAction: ['kms:Decrypt', 'kms:ReEncryptFrom'],
        Resource: '*',
      },
      {
        Sid: 'ServicesDecryptTheirEnvironment',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: 'kms:Decrypt',
        Resource: '*',
        Condition: {
          StringEquals: {
            'kms:CallerAccount': accountId,
            'kms:ViaService': [`s3.${region}.amazonaws.com`, `secretsmanager.${region}.amazonaws.com`],
          },
          ArnEquals: { 'aws:PrincipalArn': readerArns },
        },
      },
    ],
  };
}

export interface EnvStorage {
  bucket: Output<string>;
  region: Output<string>;
  partition: Output<string>;
  kmsKeyArn?: Output<string>;
  /** The Secrets Manager secret for the values that span lines. */
  secretName: string;
  /**
   * Resolve when the policies that let a service read its environment are in
   * place. The service waits for them before it starts containers.
   */
  readyFor(serviceName: string, ownRole: boolean): Promise<Resource>[];
  /** The `executionRole` transform that lets a role SST creates read the environment. */
  executionRoleTransform: (args: aws.iam.RoleArgs) => void;
  /**
   * Creates the policies that only let the services' execution roles read the
   * environment, once the roles exist. An execution role the app brings gets
   * the read policy attached, as no transform reaches it.
   */
  grantReaders(readers: EnvReader[]): void;
}

export interface EnvReader {
  /** The service, which names the policy attachment of an execution role the app brings. */
  serviceName: string;
  executionRole: aws.iam.Role;
  /** Whether the app brings the execution role (`advanced.executionRole`). */
  ownRole: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));

  return { promise, resolve };
}

/**
 * Creates the private bucket the env files are uploaded to, the policy the
 * services read them with, and with `kms`, the key that encrypts them. S3
 * encrypts every object (SSE-S3) unless the upload names the key. Replaced
 * env files are tagged by the upload and expire after
 * `SUPERSEDED_ENV_FILE_DAYS`. Like SST's own buckets, it is emptied and
 * removed with the stage, unless the app sets `removal: "retain"`.
 */
export function createEnvStorage(
  parent: ComponentResource,
  name: string,
  options: { kms?: boolean; secretName: string },
): EnvStorage {
  const opts = { parent };
  const accountId = aws.getCallerIdentityOutput({}, opts).accountId;
  const partition = aws.getPartitionOutput({}, opts).partition;
  const region = aws.getRegionOutput({}, opts).region;
  const bucket = new aws.s3.Bucket(`${name}-EnvFiles`, { forceDestroy: true }, opts);

  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    `${name}-EnvFilesPublicAccessBlock`,
    {
      bucket: bucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    opts,
  );

  new aws.s3.BucketLifecycleConfiguration(
    `${name}-EnvFilesLifecycle`,
    {
      bucket: bucket.bucket,
      rules: [
        {
          id: 'expire-superseded-env-files',
          status: 'Enabled',
          filter: { tag: { key: SUPERSEDED_TAG, value: 'true' } },
          expiration: { days: SUPERSEDED_ENV_FILE_DAYS },
        },
      ],
    },
    opts,
  );

  const readPolicy = new aws.iam.Policy(
    `${name}-EnvRead`,
    {
      description: `Reads the environment of the ${name} Laravel services (sst-laravel).`,
      policy: all([bucket.arn, partition, region, accountId]).apply(([bucketArn, part, reg, account]) =>
        JSON.stringify(buildEnvReadPolicy({
          bucketArn,
          secretArn: `arn:${part}:secretsmanager:${reg}:${account}:secret:${options.secretName}-??????`,
        })),
      ),
    },
    opts,
  );

  // SST components only allow the children it knows how to name. A KMS key
  // and a policy attachment aren't among them, so they sit at the top of the
  // stack, with the component's AWS provider.
  const topLevel = { provider: parent.getProvider('aws::') };
  const key = options.kms
    ? new aws.kms.Key(
        `${name}-EnvKey`,
        {
          description: `Encrypts the environment of the ${name} Laravel services (sst-laravel).`,
          enableKeyRotation: true,
          deletionWindowInDays: 7,
        },
        topLevel,
      )
    : undefined;

  const bucketPolicy = deferred<Resource>();
  const keyPolicy = key ? deferred<Resource>() : undefined;
  const attachments = new Map<string, ReturnType<typeof deferred<Resource>>>();

  return {
    bucket: bucket.bucket,
    region,
    partition,
    kmsKeyArn: key?.arn,
    secretName: options.secretName,
    readyFor(serviceName, ownRole) {
      const ready = [bucketPolicy.promise, ...(keyPolicy ? [keyPolicy.promise] : [])];

      if (ownRole) {
        const attachment = deferred<Resource>();
        attachments.set(serviceName, attachment);
        ready.push(attachment.promise);
      }

      return ready;
    },
    executionRoleTransform(roleArgs) {
      roleArgs.managedPolicyArns = all([roleArgs.managedPolicyArns ?? [], readPolicy.arn]).apply(([arns, arn]) => [
        ...arns,
        arn,
      ]);
    },
    grantReaders(readers) {
      const readerArns = all(readers.map((reader) => reader.executionRole.arn)).apply((arns) => [...new Set(arns)].sort());

      bucketPolicy.resolve(new aws.s3.BucketPolicy(
        `${name}-EnvFilesPolicy`,
        {
          bucket: bucket.bucket,
          policy: all([bucket.arn, readerArns]).apply(([bucketArn, arns]) =>
            JSON.stringify(buildEnvBucketPolicy({ bucketArn, readerArns: arns })),
          ),
        },
        { parent, dependsOn: publicAccessBlock },
      ));

      if (key && keyPolicy) {
        keyPolicy.resolve(new aws.kms.KeyPolicy(
          `${name}-EnvKeyPolicy`,
          {
            keyId: key.id,
            policy: all([accountId, partition, region, readerArns]).apply(([account, part, reg, arns]) =>
              JSON.stringify(buildEnvKeyPolicy({ accountId: account, partition: part, region: reg, readerArns: arns })),
            ),
          },
          topLevel,
        ));
      }

      for (const reader of readers.filter((reader) => reader.ownRole)) {
        attachments.get(reader.serviceName)?.resolve(new aws.iam.RolePolicyAttachment(
          `${reader.serviceName}-EnvReadAttachment`,
          { role: reader.executionRole.name, policyArn: readPolicy.arn },
          topLevel,
        ));
      }
    },
  };
}

/** The env file's place for the `EnvFile` resource. */
export function envFileStorageInput(storage: EnvStorage) {
  return all([storage.bucket, storage.region, storage.partition, storage.kmsKeyArn]).apply(
    ([bucket, region, partition, kmsKeyArn]) => ({
      bucket,
      region,
      partition,
      secretName: storage.secretName,
      ...(kmsKeyArn ? { kmsKeyArn } : {}),
    }),
  );
}
