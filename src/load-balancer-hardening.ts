import { Ports } from './load-balancer';

/**
 * The options of the `loadBalancer` block on `web`, `workers[]`, and
 * `reverb`. They only do something when the service has its own load
 * balancer.
 */
export const LOAD_BALANCER_KEYS = [
  'sslPolicy',
  'ingressCidrs',
  'accessLogs',
] as const;

export type LoadBalancerKey = (typeof LOAD_BALANCER_KEYS)[number];

/**
 * The policy AWS recommends for HTTPS listeners, and the one the AWS console
 * picks. It accepts TLS 1.3 and 1.2 only. A listener created through the API
 * gets `ELBSecurityPolicy-2016-08` instead, which still accepts TLS 1.0 and
 * 1.1.
 *
 * @see https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html
 */
export const DEFAULT_SSL_POLICY = 'ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09';

/**
 * A public load balancer accepts traffic from everywhere, but only on the
 * ports it listens on.
 */
export const DEFAULT_INGRESS_CIDRS = ['0.0.0.0/0'];

export const DEFAULT_ACCESS_LOGS_RETENTION_DAYS = 90;

/**
 * Checks the `loadBalancer` block of a service before anything is created.
 *
 * It can only have the options it takes. A typo in a security option must
 * not go unnoticed, and neither must the SST load balancer config (`rules`,
 * `ports`, ...), which goes in `advanced.loadBalancer`.
 *
 * The options also cannot be used with a shared load balancer (the
 * `advanced.loadBalancer` of the service has an `instance`). It is not
 * created by the service, so they would never be applied.
 */
export function assertLoadBalancerArgs(
  label: string,
  loadBalancer: unknown,
  advancedLoadBalancer?: unknown,
): void {
  if (loadBalancer === undefined) {
    return;
  }

  const expected = `It takes ${LOAD_BALANCER_KEYS.join(', ')}. The SST load balancer config goes in ${label}.advanced.loadBalancer.`;

  if (
    !loadBalancer ||
    typeof loadBalancer !== 'object' ||
    Array.isArray(loadBalancer) ||
    loadBalancer instanceof Promise ||
    typeof (loadBalancer as { apply?: unknown }).apply === 'function'
  ) {
    throw new Error(
      `[sst-laravel] ${label}.loadBalancer must be an object. ${expected}`,
    );
  }

  const unknown = Object.keys(loadBalancer).filter(
    (key) => !(LOAD_BALANCER_KEYS as readonly string[]).includes(key),
  );

  if (unknown.length > 0) {
    throw new Error(
      `[sst-laravel] ${label}.loadBalancer does not take ${unknown
        .map((key) => `"${key}"`)
        .join(', ')}. ${expected}`,
    );
  }

  const keys = findLoadBalancerKeys(loadBalancer);

  if (keys.length > 0 && getLoadBalancerKind(advancedLoadBalancer) === 'shared') {
    throw new Error(
      `[sst-laravel] ${keys
        .map((key) => `${label}.loadBalancer.${key}`)
        .join(
          ', ',
        )} cannot be used with a shared load balancer (${label}.advanced.loadBalancer.instance). Configure the sst.aws.Alb itself instead.`,
    );
  }
}

/**
 * Lists the options actually set, so the component can warn or fail when the
 * service has no load balancer of its own. `false` counts as not set, so
 * `accessLogs: false` stays silent.
 */
export function findLoadBalancerKeys(
  loadBalancer?: Partial<Record<LoadBalancerKey, unknown>>,
): LoadBalancerKey[] {
  if (!loadBalancer) {
    return [];
  }

  return LOAD_BALANCER_KEYS.filter(
    (key) => loadBalancer[key] !== undefined && loadBalancer[key] !== false,
  );
}

/**
 * - `none`: the service has no load balancer.
 * - `shared`: the service attaches to an existing `sst.aws.Alb` through
 *   `loadBalancer.instance`. The load balancer, its listeners, and its
 *   security group belong to that component, so the service transforms never
 *   run for them.
 * - `dedicated`: SST creates a load balancer for this service.
 */
export type LoadBalancerKind = 'none' | 'shared' | 'dedicated';

export function getLoadBalancerKind(loadBalancer: unknown): LoadBalancerKind {
  if (!loadBalancer) {
    return 'none';
  }

  if (typeof loadBalancer === 'object' && 'instance' in loadBalancer) {
    return 'shared';
  }

  return 'dedicated';
}

/**
 * Listener protocols that carry TLS and therefore accept an SSL policy.
 * AWS rejects an SSL policy on any other listener protocol (e.g. HTTP).
 */
export const TLS_LISTENER_PROTOCOLS = ['HTTPS', 'TLS'] as const;

/**
 * Resolves the SSL policy to apply to a single listener. Returns the policy
 * (`DEFAULT_SSL_POLICY` when none is set) for HTTPS/TLS listeners and
 * `undefined` for every other protocol, so the caller can assign the result
 * to every listener.
 */
export function resolveListenerSslPolicy(
  protocol: string | undefined,
  sslPolicy?: string,
): string | undefined {
  if (!protocol) {
    return undefined;
  }

  return (TLS_LISTENER_PROTOCOLS as readonly string[]).includes(
    protocol.toUpperCase(),
  )
    ? sslPolicy || DEFAULT_SSL_POLICY
    : undefined;
}

export interface ListenerPort {
  port: number;
  /**
   * The security group protocol the listener needs open.
   */
  protocol: 'tcp' | 'udp';
}

/**
 * Listen ports used for `ingressCidrs` when the load balancer config cannot
 * be read while the program runs (for example when it is a Pulumi `Output`).
 */
export const FALLBACK_LISTENER_PORTS: ListenerPort[] = [
  { port: 80, protocol: 'tcp' },
  { port: 443, protocol: 'tcp' },
];

function getSecurityGroupProtocols(
  listenProtocol: string | undefined,
): ListenerPort['protocol'][] {
  switch (listenProtocol?.toLowerCase()) {
    case 'udp':
      return ['udp'];
    case 'tcp_udp':
      return ['tcp', 'udp'];
    default:
      return ['tcp'];
  }
}

/**
 * Extracts the unique listener ports (in declaration order) from a load
 * balancer port mapping, e.g. `[{ listen: '80/http', ... }]` becomes
 * `[{ port: 80, protocol: 'tcp' }]`.
 */
export function extractListenerPorts(ports: Ports): ListenerPort[] {
  const listenerPorts: ListenerPort[] = [];

  for (const entry of ports) {
    const [rawPort, listenProtocol] = entry.listen.split('/');
    const port = Number.parseInt(rawPort, 10);

    if (Number.isNaN(port)) {
      continue;
    }

    for (const protocol of getSecurityGroupProtocols(listenProtocol)) {
      if (
        !listenerPorts.some(
          (listener) => listener.port === port && listener.protocol === protocol,
        )
      ) {
        listenerPorts.push({ port, protocol });
      }
    }
  }

  return listenerPorts;
}

/**
 * Reads the listener ports from an SST load balancer config, the same way
 * SST does (`rules`, falling back to the older `ports`). Returns `undefined`
 * when the config, or any of its entries, is not a plain value, for example
 * when it is a Pulumi `Output` that only resolves during the deploy.
 */
export function getStaticListenerPorts(
  loadBalancer: unknown,
): ListenerPort[] | undefined {
  if (!loadBalancer || typeof loadBalancer !== 'object') {
    return undefined;
  }

  const { rules, ports } = loadBalancer as { rules?: unknown; ports?: unknown };
  const entries = rules ?? ports;

  if (!Array.isArray(entries)) {
    return undefined;
  }

  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { listen?: unknown }).listen !== 'string'
    ) {
      return undefined;
    }
  }

  const listenerPorts = extractListenerPorts(entries as Ports);

  return listenerPorts.length > 0 ? listenerPorts : undefined;
}

export interface IngressCidrBlocks {
  v4?: string[];
  v6?: string[];
}

function isIpv6Cidr(cidr: string): boolean {
  return cidr.includes(':');
}

/**
 * Normalizes the two accepted `ingressCidrs` shapes into IPv4 and IPv6 lists.
 * A plain list is split by address family. With the `{ v4, v6 }` shape, each
 * block has to be in the list of its own family, since AWS takes them in
 * separate fields and rejects a mismatch only once the deploy is running.
 */
export function normalizeIngressCidrs(
  cidrs: string[] | IngressCidrBlocks | undefined,
): Required<IngressCidrBlocks> {
  if (Array.isArray(cidrs)) {
    return {
      v4: cidrs.filter((cidr) => !isIpv6Cidr(cidr)),
      v6: cidrs.filter(isIpv6Cidr),
    };
  }

  const v4 = cidrs?.v4 ?? [];
  const v6 = cidrs?.v6 ?? [];

  const misplacedV6 = v4.find(isIpv6Cidr);
  if (misplacedV6) {
    throw new Error(
      `"loadBalancer.ingressCidrs.v4" contains the IPv6 block "${misplacedV6}". Move it to "v6".`,
    );
  }

  const misplacedV4 = v6.find((cidr) => !isIpv6Cidr(cidr));
  if (misplacedV4) {
    throw new Error(
      `"loadBalancer.ingressCidrs.v6" contains the IPv4 block "${misplacedV4}". Move it to "v4".`,
    );
  }

  return { v4, v6 };
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
 * Builds the load balancer security group ingress rules: one rule per
 * listener port, restricted to the given IPv4/IPv6 blocks. Replaces the rule
 * SST creates, which opens every port and protocol to everyone.
 */
export function buildIngressRules(
  listenerPorts: ListenerPort[],
  cidrs: string[] | IngressCidrBlocks | undefined,
): SecurityGroupIngressRule[] {
  const { v4, v6 } = normalizeIngressCidrs(cidrs);

  if (v4.length === 0 && v6.length === 0) {
    throw new Error(
      '"loadBalancer.ingressCidrs" requires at least one IPv4 or IPv6 CIDR block.',
    );
  }

  if (listenerPorts.length === 0) {
    throw new Error(
      '"loadBalancer.ingressCidrs" could not determine any listener ports. Set "ingressCidrs.ports".',
    );
  }

  return listenerPorts.map(({ port, protocol }) => ({
    description: 'Managed by SST Laravel',
    protocol,
    fromPort: port,
    toPort: port,
    ...(v4.length > 0 ? { cidrBlocks: v4 } : {}),
    ...(v6.length > 0 ? { ipv6CidrBlocks: v6 } : {}),
  }));
}

/**
 * Resolves how long the bucket the package creates keeps the access logs.
 * Returns `undefined` when they are kept forever (`false`).
 */
export function resolveAccessLogsRetentionDays(
  retentionDays: number | false | undefined,
): number | undefined {
  if (retentionDays === false) {
    return undefined;
  }

  const days = retentionDays ?? DEFAULT_ACCESS_LOGS_RETENTION_DAYS;

  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      '"loadBalancer.accessLogs.retentionDays" must be a whole number of days, or false to keep the logs forever.',
    );
  }

  return days;
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
      '"loadBalancer.accessLogs.prefix" must not include "AWSLogs".',
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
 * deliver access logs into the bucket, following the AWS guide: the
 * log-delivery service can only write under `AWSLogs/<account-id>`, and only
 * for load balancers of this account and region. Like the buckets SST
 * creates, requests over plain HTTP are denied.
 *
 * @see https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html
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
  const partition = bucketArn.split(':')[1];

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ElbLogDelivery',
        Effect: 'Allow',
        Principal: {
          Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
        },
        Action: 's3:PutObject',
        Resource: `${bucketArn}/${
          normalizedPrefix ? `${normalizedPrefix}/` : ''
        }AWSLogs/${accountId}/*`,
        Condition: {
          ArnLike: {
            'aws:SourceArn': `arn:${partition}:elasticloadbalancing:${region}:${accountId}:loadbalancer/*`,
          },
        },
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
