import { all, ComponentResource, Input, Output, output } from '@pulumi/pulumi';
import type {
  LaravelIngressCidrsArgs,
  LaravelLoadBalancerAccessLogsArgs,
  LaravelLoadBalancerArgs,
} from '../laravel-sst';
import {
  buildAccessLogsBucketPolicy,
  buildIngressRules,
  DEFAULT_INGRESS_CIDRS,
  FALLBACK_LISTENER_PORTS,
  findLoadBalancerKeys,
  getLoadBalancerKind,
  getStaticListenerPorts,
  normalizeAccessLogsPrefix,
  resolveAccessLogsRetentionDays,
  resolveListenerSslPolicy,
} from './load-balancer-hardening';

/** The transforms the package generates for the load balancer options. */
export type LoadBalancerHardeningTransforms = {
  listener?: (args: aws.lb.ListenerArgs) => void;
  loadBalancer?: (args: aws.lb.LoadBalancerArgs, opts: $util.CustomResourceOptions) => void;
  loadBalancerSecurityGroup?: (args: aws.ec2.SecurityGroupArgs) => void;
};

/**
 * Creates the bucket the load balancer delivers its access logs to. It
 * keeps the S3 default encryption (SSE-S3): ELB cannot deliver logs to a
 * bucket encrypted with a KMS key.
 *
 * Like SST's own buckets, it is emptied and removed with the stage, unless
 * the app sets `removal: "retain"`.
 */
function createAccessLogsBucket(
  parent: ComponentResource,
  serviceName: string,
  config: LaravelLoadBalancerAccessLogsArgs,
) {
  const bucket = new aws.s3.Bucket(`${serviceName}-AccessLogs`, { forceDestroy: true }, { parent });

  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    `${serviceName}-AccessLogsPublicAccessBlock`,
    {
      bucket: bucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    { parent },
  );

  const policy = new aws.s3.BucketPolicy(
    `${serviceName}-AccessLogsPolicy`,
    {
      bucket: bucket.bucket,
      policy: all([
        bucket.arn,
        aws.getCallerIdentityOutput({}, { parent }).accountId,
        aws.getRegionOutput({}, { parent }).region,
        config.prefix,
      ]).apply(([bucketArn, accountId, region, prefix]) =>
        JSON.stringify(buildAccessLogsBucketPolicy({ bucketArn, accountId, region, prefix })),
      ),
    },
    { parent, dependsOn: publicAccessBlock },
  );

  const retentionDays = resolveAccessLogsRetentionDays(config.retentionDays);

  if (retentionDays) {
    new aws.s3.BucketLifecycleConfiguration(
      `${serviceName}-AccessLogsLifecycle`,
      {
        bucket: bucket.bucket,
        rules: [
          {
            id: 'expire-access-logs',
            status: 'Enabled',
            filter: {},
            expiration: { days: retentionDays },
          },
        ],
      },
      { parent },
    );
  }

  return { bucket: bucket.bucket, policy };
}

/**
 * Builds the transforms that harden the load balancer SST creates for a
 * service, from the secure defaults and the `loadBalancer` options of the
 * block (`sslPolicy`, `ingressCidrs`, `accessLogs`).
 */
export function buildLoadBalancerHardening(
  parent: ComponentResource,
  label: string,
  serviceName: string,
  config: LaravelLoadBalancerArgs = {},
  loadBalancer: unknown,
): LoadBalancerHardeningTransforms {
  const kind = getLoadBalancerKind(loadBalancer);

  // Nothing to harden: the service has no load balancer, or it uses a
  // shared one, which belongs to its own component.
  if (kind !== 'dedicated') {
    const keys = findLoadBalancerKeys(config);

    if (keys.length > 0 && kind === 'none') {
      console.warn(
        `[sst-laravel] ${keys
          .map((key) => `${label}.loadBalancer.${key}`)
          .join(', ')} ignored: ${label} has no load balancer.`,
      );
    }

    return {};
  }

  const hardening: LoadBalancerHardeningTransforms = {
    listener: (listenerArgs) => {
      listenerArgs.sslPolicy = all([listenerArgs.protocol, config.sslPolicy]).apply(([protocol, policy]) =>
        resolveListenerSslPolicy(protocol, policy),
      ) as Output<string>;
    },
  };

  const listenerPorts = getStaticListenerPorts(loadBalancer);
  const ingressCidrs = config.ingressCidrs;

  if (ingressCidrs) {
    const ingress =
      Array.isArray(ingressCidrs) || ingressCidrs instanceof Promise || Output.isInstance(ingressCidrs)
        ? output(ingressCidrs as Input<string[]>).apply((cidrs) =>
            buildIngressRules(listenerPorts ?? FALLBACK_LISTENER_PORTS, cidrs),
          )
        : all([
            (ingressCidrs as LaravelIngressCidrsArgs).v4,
            (ingressCidrs as LaravelIngressCidrsArgs).v6,
            (ingressCidrs as LaravelIngressCidrsArgs).ports,
          ]).apply(([v4, v6, ports]) =>
            buildIngressRules(
              ports?.map((port) => ({ port, protocol: 'tcp' as const })) ?? listenerPorts ?? FALLBACK_LISTENER_PORTS,
              { v4, v6 },
            ),
          );

    hardening.loadBalancerSecurityGroup = (sgArgs) => {
      sgArgs.ingress = ingress;
    };
  } else if (listenerPorts) {
    // Without the ports, keep the rule SST creates. Guessing them could
    // lock everyone out of a custom load balancer.
    hardening.loadBalancerSecurityGroup = (sgArgs) => {
      sgArgs.ingress = buildIngressRules(listenerPorts, DEFAULT_INGRESS_CIDRS);
    };
  }

  const accessLogs = config.accessLogs === true ? {} : config.accessLogs || undefined;
  const ownBucket = accessLogs?.bucket;
  const createdBucket = accessLogs && !ownBucket ? createAccessLogsBucket(parent, serviceName, accessLogs) : undefined;

  hardening.loadBalancer = (lbArgs, opts) => {
    // Only application load balancers read HTTP headers.
    lbArgs.dropInvalidHeaderFields = output(lbArgs.loadBalancerType).apply((type) =>
      type === 'network' ? undefined : true,
    ) as Output<boolean>;

    if (!accessLogs) {
      return;
    }

    lbArgs.accessLogs = {
      bucket:
        createdBucket?.bucket ??
        (typeof ownBucket === 'object' && !(ownBucket instanceof Promise) && !Output.isInstance(ownBucket)
          ? (ownBucket as { name: Input<string> }).name
          : (ownBucket as Input<string>)),
      prefix: output(accessLogs.prefix).apply((prefix) => normalizeAccessLogsPrefix(prefix)) as Output<string>,
      enabled: accessLogs.enabled ?? true,
    };

    // AWS checks it can write to the bucket when access logs are turned
    // on, so the bucket policy has to exist first.
    if (createdBucket) {
      opts.dependsOn = [...([opts.dependsOn ?? []].flat() as $util.Resource[]), createdBucket.policy];
    }
  };

  return hardening;
}
