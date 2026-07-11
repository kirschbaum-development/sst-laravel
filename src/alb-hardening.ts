import { Ports } from './load-balancer';

/**
 * Listener protocols that carry TLS and therefore accept an SSL policy.
 * Applying an SSL policy to any other listener protocol (e.g. HTTP) is
 * rejected by AWS, so the package only applies the policy to these.
 */
export const TLS_LISTENER_PROTOCOLS = ['HTTPS', 'TLS'] as const;

/**
 * Resolves the SSL policy to apply to a single listener. Returns the policy
 * for HTTPS/TLS listeners and `undefined` for every other protocol, so the
 * caller can assign the result unconditionally without tripping the AWS
 * "SSL policy is not supported for HTTP listeners" error.
 */
export function resolveListenerSslPolicy(
  protocol: string | undefined,
  sslPolicy: string | undefined,
): string | undefined {
  if (!protocol || !sslPolicy) {
    return undefined;
  }

  return (TLS_LISTENER_PROTOCOLS as readonly string[]).includes(
    protocol.toUpperCase(),
  )
    ? sslPolicy
    : undefined;
}

/**
 * Extracts the unique listen ports (in declaration order) from a load
 * balancer `ports` mapping, e.g. `[{ listen: '80/http', ... }]` -> `[80]`.
 */
export function extractListenPorts(ports: Ports): number[] {
  const listenPorts: number[] = [];

  for (const entry of ports) {
    const port = Number.parseInt(entry.listen.split('/')[0], 10);

    if (!Number.isNaN(port) && !listenPorts.includes(port)) {
      listenPorts.push(port);
    }
  }

  return listenPorts;
}

/**
 * Best-effort static extraction of the listen ports from a `loadBalancer`
 * config block. Returns `undefined` when the config (or any of its port
 * entries) is not a plain, statically-known value — for example when it is a
 * Pulumi `Input` that only resolves at deploy time.
 */
export function getStaticListenPorts(
  loadBalancer: unknown,
): number[] | undefined {
  if (!loadBalancer || typeof loadBalancer !== 'object') {
    return undefined;
  }

  const ports = (loadBalancer as { ports?: unknown }).ports;

  if (!Array.isArray(ports)) {
    return undefined;
  }

  for (const entry of ports) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { listen?: unknown }).listen !== 'string'
    ) {
      return undefined;
    }
  }

  const listenPorts = extractListenPorts(ports as Ports);

  return listenPorts.length > 0 ? listenPorts : undefined;
}

export interface IngressCidrBlocks {
  v4?: string[];
  v6?: string[];
}

export interface SecurityGroupIngressRule {
  description: string;
  protocol: string;
  fromPort: number;
  toPort: number;
  cidrBlocks?: string[];
  ipv6CidrBlocks?: string[];
}

/**
 * Builds the load balancer security group ingress rules for a CIDR allowlist:
 * one TCP rule per listen port, restricted to the given IPv4/IPv6 blocks.
 * Replaces SST's default allow-all ingress so the load balancer can only be
 * reached from the allowlisted ranges (e.g. a WAF or CDN edge).
 */
export function buildIngressRules(
  listenPorts: number[],
  cidrs: IngressCidrBlocks,
): SecurityGroupIngressRule[] {
  const v4 = cidrs.v4 ?? [];
  const v6 = cidrs.v6 ?? [];

  if (v4.length === 0 && v6.length === 0) {
    throw new Error(
      '"ingressCidrs" requires at least one IPv4 or IPv6 CIDR block.',
    );
  }

  if (listenPorts.length === 0) {
    throw new Error(
      '"ingressCidrs" could not determine any listen ports. Set "ingressCidrs.ports" explicitly.',
    );
  }

  return listenPorts.map((port) => ({
    description: 'Managed by SST Laravel (ingressCidrs)',
    protocol: 'tcp',
    fromPort: port,
    toPort: port,
    ...(v4.length > 0 ? { cidrBlocks: v4 } : {}),
    ...(v6.length > 0 ? { ipv6CidrBlocks: v6 } : {}),
  }));
}

/**
 * AWS accounts that Elastic Load Balancing writes access logs from, per
 * region, for regions that existed before August 2022. This table is frozen:
 * regions launched later use the `logdelivery.elasticloadbalancing.amazonaws.com`
 * service principal instead, which the bucket policy always includes.
 *
 * @see https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html
 */
export const ELB_ACCESS_LOGS_ACCOUNT_IDS: Record<string, string> = {
  'us-east-1': '127311923021',
  'us-east-2': '033677994240',
  'us-west-1': '027434742980',
  'us-west-2': '797873946194',
  'af-south-1': '098369216593',
  'ap-east-1': '754344448648',
  'ap-southeast-3': '589379963580',
  'ap-south-1': '718504428378',
  'ap-northeast-3': '383597477331',
  'ap-northeast-2': '600734575887',
  'ap-southeast-1': '114774131450',
  'ap-southeast-2': '783225319266',
  'ap-northeast-1': '582318560864',
  'ca-central-1': '985666609251',
  'eu-central-1': '054676820928',
  'eu-west-1': '156460612806',
  'eu-west-2': '652711504416',
  'eu-south-1': '635631232127',
  'eu-west-3': '009996457667',
  'eu-north-1': '897822967062',
  'me-south-1': '076674570225',
  'sa-east-1': '507241528517',
  'us-gov-west-1': '048591011584',
  'us-gov-east-1': '190560391635',
  'cn-north-1': '638102146993',
  'cn-northwest-1': '037604701340',
};

/**
 * Returns the IAM root ARN of the regional ELB log-delivery account, or
 * `undefined` for regions launched after August 2022 (those are covered by
 * the log-delivery service principal instead).
 */
export function getElbAccessLogsAccountArn(
  region: string,
): string | undefined {
  const accountId = ELB_ACCESS_LOGS_ACCOUNT_IDS[region];

  if (!accountId) {
    return undefined;
  }

  const partition = region.startsWith('cn-')
    ? 'aws-cn'
    : region.startsWith('us-gov-')
      ? 'aws-us-gov'
      : 'aws';

  return `arn:${partition}:iam::${accountId}:root`;
}

/**
 * Normalizes an access-logs S3 prefix by stripping leading/trailing slashes,
 * since ELB rejects prefixes that start or end with a slash. Returns
 * `undefined` for empty prefixes and rejects the reserved `AWSLogs` segment.
 */
export function normalizeAccessLogsPrefix(
  prefix: string | undefined,
): string | undefined {
  const trimmed = prefix?.replace(/^\/+|\/+$/g, '');

  if (trimmed?.includes('AWSLogs')) {
    throw new Error(
      '"loadBalancerAccessLogs.prefix" must not include "AWSLogs".',
    );
  }

  return trimmed || undefined;
}

export interface AccessLogsBucketPolicyOptions {
  bucketArn: string;
  accountId: string;
  region: string;
  prefix?: string;
}

/**
 * Builds the S3 bucket policy document that allows Elastic Load Balancing to
 * deliver access logs into the bucket. Grants both the regional ELB account
 * (regions that existed before August 2022) and the log-delivery service
 * principal (later regions), scoped to the `AWSLogs/<account-id>` key space
 * ELB actually writes to.
 */
export function buildAccessLogsBucketPolicy({
  bucketArn,
  accountId,
  region,
  prefix,
}: AccessLogsBucketPolicyOptions): {
  Version: string;
  Statement: object[];
} {
  const normalizedPrefix = normalizeAccessLogsPrefix(prefix);
  const resource = `${bucketArn}/${
    normalizedPrefix ? `${normalizedPrefix}/` : ''
  }AWSLogs/${accountId}/*`;
  const elbAccountArn = getElbAccessLogsAccountArn(region);

  return {
    Version: '2012-10-17',
    Statement: [
      ...(elbAccountArn
        ? [
            {
              Sid: 'ElbRegionalAccountLogDelivery',
              Effect: 'Allow',
              Principal: { AWS: elbAccountArn },
              Action: 's3:PutObject',
              Resource: resource,
            },
          ]
        : []),
      {
        Sid: 'ElbLogDeliveryService',
        Effect: 'Allow',
        Principal: {
          Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
        },
        Action: 's3:PutObject',
        Resource: resource,
      },
    ],
  };
}
