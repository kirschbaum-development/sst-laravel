import { describe, expect, it } from 'vitest';
import {
  assertLoadBalancerArgs,
  buildAccessLogsBucketPolicy,
  buildIngressRules,
  DEFAULT_INGRESS_CIDRS,
  DEFAULT_SSL_POLICY,
  extractListenerPorts,
  findLoadBalancerKeys,
  getLoadBalancerKind,
  getStaticListenerPorts,
  normalizeAccessLogsPrefix,
  normalizeIngressCidrs,
  resolveAccessLogsRetentionDays,
  resolveListenerSslPolicy,
} from '../src/load-balancer-hardening';
import { buildDefaultPublicPorts } from '../src/load-balancer';

const SSL_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06';

describe('assertLoadBalancerArgs', () => {
  it('accepts a block that is not set or has no options', () => {
    expect(() => assertLoadBalancerArgs('web', undefined)).not.toThrow();
    expect(() => assertLoadBalancerArgs('web', {})).not.toThrow();
  });

  it('accepts the load balancer options', () => {
    expect(() =>
      assertLoadBalancerArgs('web', {
        sslPolicy: SSL_POLICY,
        ingressCidrs: ['173.245.48.0/20'],
        accessLogs: true,
      }),
    ).not.toThrow();
  });

  it('rejects the SST load balancer config and points to its new place', () => {
    expect(() =>
      assertLoadBalancerArgs('web', {
        rules: [{ listen: '80/http', forward: '8080/http' }],
        health: {},
        accessLogs: true,
      }),
    ).toThrow(
      '[sst-laravel] web.loadBalancer does not take "rules", "health". It takes sslPolicy, ingressCidrs, accessLogs. The SST load balancer config goes in web.advanced.loadBalancer.',
    );
  });

  it('rejects a misspelled option instead of ignoring it', () => {
    expect(() =>
      assertLoadBalancerArgs('reverb', { ingressCidr: ['173.245.48.0/20'] }),
    ).toThrow(/reverb.loadBalancer does not take "ingressCidr"/);
  });

  it('rejects the options on a shared load balancer', () => {
    const shared = { instance: {}, rules: [] };

    expect(() =>
      assertLoadBalancerArgs(
        'web',
        { sslPolicy: SSL_POLICY, accessLogs: true },
        shared,
      ),
    ).toThrow(
      '[sst-laravel] web.loadBalancer.sslPolicy, web.loadBalancer.accessLogs cannot be used with a shared load balancer (web.advanced.loadBalancer.instance). Configure the sst.aws.Alb itself instead.',
    );
  });

  it('accepts a shared load balancer when no option is set', () => {
    const shared = { instance: {}, rules: [] };

    expect(() => assertLoadBalancerArgs('web', undefined, shared)).not.toThrow();
    expect(() => assertLoadBalancerArgs('web', {}, shared)).not.toThrow();
    expect(() =>
      assertLoadBalancerArgs('web', { accessLogs: false }, shared),
    ).not.toThrow();
  });

  it('accepts the options on a load balancer of the service', () => {
    expect(() =>
      assertLoadBalancerArgs(
        'web',
        { accessLogs: true },
        { rules: [{ listen: '80/http', forward: '8080/http' }] },
      ),
    ).not.toThrow();
  });

  it('rejects a value that is not a plain object', () => {
    const message = /web.loadBalancer must be an object/;

    expect(() => assertLoadBalancerArgs('web', true)).toThrow(message);
    expect(() => assertLoadBalancerArgs('web', null)).toThrow(message);
    expect(() => assertLoadBalancerArgs('web', [])).toThrow(message);
    expect(() =>
      assertLoadBalancerArgs('web', { apply: () => undefined }),
    ).toThrow(message);
    expect(() => assertLoadBalancerArgs('web', Promise.resolve({}))).toThrow(
      message,
    );
  });
});

describe('findLoadBalancerKeys', () => {
  it('returns an empty list when no option is used', () => {
    expect(findLoadBalancerKeys()).toEqual([]);
    expect(findLoadBalancerKeys({})).toEqual([]);
  });

  it('lists the options that are set', () => {
    expect(
      findLoadBalancerKeys({
        sslPolicy: SSL_POLICY,
        accessLogs: true,
      }),
    ).toEqual(['sslPolicy', 'accessLogs']);
  });

  it('treats disabled access logs as not set', () => {
    expect(findLoadBalancerKeys({ accessLogs: false })).toEqual([]);
  });
});

describe('getLoadBalancerKind', () => {
  it('returns none when the service has no load balancer', () => {
    expect(getLoadBalancerKind(undefined)).toBe('none');
    expect(getLoadBalancerKind(false)).toBe('none');
  });

  it('returns shared when attaching to an existing load balancer', () => {
    expect(getLoadBalancerKind({ instance: {}, rules: [] })).toBe('shared');
  });

  it('returns dedicated when SST creates the load balancer', () => {
    expect(
      getLoadBalancerKind({
        ports: buildDefaultPublicPorts({ hasDomain: true }),
      }),
    ).toBe('dedicated');
  });
});

describe('resolveListenerSslPolicy', () => {
  it('defaults to a policy that only accepts TLS 1.2 and 1.3', () => {
    expect(DEFAULT_SSL_POLICY).toBe(
      'ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09',
    );
    expect(resolveListenerSslPolicy('HTTPS')).toBe(DEFAULT_SSL_POLICY);
    expect(resolveListenerSslPolicy('TLS', undefined)).toBe(
      DEFAULT_SSL_POLICY,
    );
  });

  it('applies the chosen policy to HTTPS listeners', () => {
    expect(resolveListenerSslPolicy('HTTPS', SSL_POLICY)).toBe(SSL_POLICY);
  });

  it('applies the chosen policy to TLS listeners', () => {
    expect(resolveListenerSslPolicy('TLS', SSL_POLICY)).toBe(SSL_POLICY);
  });

  it('matches the protocol case-insensitively', () => {
    expect(resolveListenerSslPolicy('https', SSL_POLICY)).toBe(SSL_POLICY);
  });

  it('skips plain HTTP listeners, which reject SSL policies', () => {
    expect(resolveListenerSslPolicy('HTTP', SSL_POLICY)).toBeUndefined();
    expect(resolveListenerSslPolicy('HTTP')).toBeUndefined();
  });

  it('skips TCP and UDP listeners', () => {
    expect(resolveListenerSslPolicy('TCP', SSL_POLICY)).toBeUndefined();
    expect(resolveListenerSslPolicy('UDP')).toBeUndefined();
  });

  it('returns undefined when the protocol is missing', () => {
    expect(resolveListenerSslPolicy(undefined, SSL_POLICY)).toBeUndefined();
  });
});

describe('extractListenerPorts', () => {
  it('extracts the listener ports from the default domain port mapping', () => {
    expect(
      extractListenerPorts(buildDefaultPublicPorts({ hasDomain: true })),
    ).toEqual([
      { port: 80, protocol: 'tcp' },
      { port: 443, protocol: 'tcp' },
    ]);
  });

  it('extracts a single port when no domain is configured', () => {
    expect(
      extractListenerPorts(buildDefaultPublicPorts({ hasDomain: false })),
    ).toEqual([{ port: 80, protocol: 'tcp' }]);
  });

  it('deduplicates repeated listen ports', () => {
    expect(
      extractListenerPorts([
        { listen: '443/https', forward: '8080/http' },
        { listen: '443/https', forward: '9090/http' },
      ]),
    ).toEqual([{ port: 443, protocol: 'tcp' }]);
  });

  it('opens the protocol the listener uses', () => {
    expect(
      extractListenerPorts([
        { listen: '53/udp' },
        { listen: '514/tcp_udp' },
        { listen: '443/tls' },
      ]),
    ).toEqual([
      { port: 53, protocol: 'udp' },
      { port: 514, protocol: 'tcp' },
      { port: 514, protocol: 'udp' },
      { port: 443, protocol: 'tcp' },
    ]);
  });
});

describe('getStaticListenerPorts', () => {
  it('extracts ports from a plain load balancer config', () => {
    expect(
      getStaticListenerPorts({
        ports: [
          { listen: '80/http', redirect: '443/https' },
          { listen: '443/https', forward: '8080/http' },
        ],
      }),
    ).toEqual([
      { port: 80, protocol: 'tcp' },
      { port: 443, protocol: 'tcp' },
    ]);
  });

  it('reads rules before ports, like SST does', () => {
    expect(
      getStaticListenerPorts({
        rules: [{ listen: '8443/https', forward: '8080/http' }],
        ports: [{ listen: '80/http' }],
      }),
    ).toEqual([{ port: 8443, protocol: 'tcp' }]);
  });

  it('returns undefined for non-object configs', () => {
    expect(getStaticListenerPorts(undefined)).toBeUndefined();
    expect(getStaticListenerPorts('lb')).toBeUndefined();
  });

  it('returns undefined when ports are not a statically-known array', () => {
    expect(getStaticListenerPorts({})).toBeUndefined();
    expect(getStaticListenerPorts({ ports: 'later' })).toBeUndefined();
  });

  it('returns undefined when a port entry is not statically known', () => {
    expect(
      getStaticListenerPorts({
        ports: [{ listen: '80/http' }, { listen: 443 }],
      }),
    ).toBeUndefined();
  });
});

describe('normalizeIngressCidrs', () => {
  it('splits a plain list by address family', () => {
    expect(
      normalizeIngressCidrs([
        '173.245.48.0/20',
        '2400:cb00::/32',
        '103.21.244.0/22',
      ]),
    ).toEqual({
      v4: ['173.245.48.0/20', '103.21.244.0/22'],
      v6: ['2400:cb00::/32'],
    });
  });

  it('keeps the v4 and v6 lists of the object shape', () => {
    expect(
      normalizeIngressCidrs({
        v4: ['173.245.48.0/20'],
        v6: ['2400:cb00::/32'],
      }),
    ).toEqual({ v4: ['173.245.48.0/20'], v6: ['2400:cb00::/32'] });
  });

  it('fills in the missing lists', () => {
    expect(normalizeIngressCidrs(undefined)).toEqual({ v4: [], v6: [] });
    expect(normalizeIngressCidrs({ v4: ['173.245.48.0/20'] })).toEqual({
      v4: ['173.245.48.0/20'],
      v6: [],
    });
  });

  it('rejects a block listed under the wrong address family', () => {
    expect(() => normalizeIngressCidrs({ v4: ['2400:cb00::/32'] })).toThrow(
      /"loadBalancer.ingressCidrs.v4" contains the IPv6 block "2400:cb00::\/32"/,
    );
    expect(() => normalizeIngressCidrs({ v6: ['173.245.48.0/20'] })).toThrow(
      /"loadBalancer.ingressCidrs.v6" contains the IPv4 block "173.245.48.0\/20"/,
    );
  });
});

describe('buildIngressRules', () => {
  const v4 = ['173.245.48.0/20', '103.21.244.0/22'];
  const v6 = ['2400:cb00::/32'];
  const listenerPorts = [
    { port: 80, protocol: 'tcp' as const },
    { port: 443, protocol: 'tcp' as const },
  ];

  it('only opens the listener ports by default', () => {
    expect(buildIngressRules(listenerPorts, DEFAULT_INGRESS_CIDRS)).toEqual([
      {
        description: 'Managed by SST Laravel',
        protocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        cidrBlocks: ['0.0.0.0/0'],
      },
      {
        description: 'Managed by SST Laravel',
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ['0.0.0.0/0'],
      },
    ]);
  });

  it('builds one rule per listener port with both CIDR families', () => {
    expect(buildIngressRules(listenerPorts, { v4, v6 })).toEqual([
      {
        description: 'Managed by SST Laravel',
        protocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        cidrBlocks: v4,
        ipv6CidrBlocks: v6,
      },
      {
        description: 'Managed by SST Laravel',
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: v4,
        ipv6CidrBlocks: v6,
      },
    ]);
  });

  it('accepts a plain list of CIDR blocks', () => {
    expect(buildIngressRules(listenerPorts, [...v4, ...v6])).toEqual(
      buildIngressRules(listenerPorts, { v4, v6 }),
    );
  });

  it('uses the protocol of the listener', () => {
    const [rule] = buildIngressRules([{ port: 53, protocol: 'udp' }], { v4 });

    expect(rule).toMatchObject({ protocol: 'udp', fromPort: 53, toPort: 53 });
  });

  it('omits the CIDR family that has no blocks', () => {
    const [rule] = buildIngressRules(listenerPorts, { v4 });

    expect(rule.cidrBlocks).toEqual(v4);
    expect(rule).not.toHaveProperty('ipv6CidrBlocks');

    const [v6Rule] = buildIngressRules(listenerPorts, { v6 });

    expect(v6Rule.ipv6CidrBlocks).toEqual(v6);
    expect(v6Rule).not.toHaveProperty('cidrBlocks');
  });

  it('throws when no CIDR blocks are given', () => {
    expect(() => buildIngressRules(listenerPorts, {})).toThrow(
      /at least one IPv4 or IPv6 CIDR/,
    );
    expect(() => buildIngressRules(listenerPorts, [])).toThrow(
      /at least one IPv4 or IPv6 CIDR/,
    );
    expect(() =>
      buildIngressRules(listenerPorts, { v4: [], v6: [] }),
    ).toThrow(/at least one IPv4 or IPv6 CIDR/);
  });

  it('throws when no listener ports could be determined', () => {
    expect(() => buildIngressRules([], { v4 })).toThrow(
      /could not determine any listener ports/,
    );
  });
});

describe('resolveAccessLogsRetentionDays', () => {
  it('keeps the logs for 90 days by default', () => {
    expect(resolveAccessLogsRetentionDays(undefined)).toBe(90);
  });

  it('uses the given number of days', () => {
    expect(resolveAccessLogsRetentionDays(365)).toBe(365);
  });

  it('keeps the logs forever when set to false', () => {
    expect(resolveAccessLogsRetentionDays(false)).toBeUndefined();
  });

  it('rejects a value that is not a whole number of days', () => {
    const message = /must be a whole number of days/;

    expect(() => resolveAccessLogsRetentionDays(0)).toThrow(message);
    expect(() => resolveAccessLogsRetentionDays(-1)).toThrow(message);
    expect(() => resolveAccessLogsRetentionDays(1.5)).toThrow(message);
  });
});

describe('normalizeAccessLogsPrefix', () => {
  it('strips leading and trailing slashes', () => {
    expect(normalizeAccessLogsPrefix('/alb/')).toBe('alb');
    expect(normalizeAccessLogsPrefix('alb/web')).toBe('alb/web');
  });

  it('returns undefined for empty prefixes', () => {
    expect(normalizeAccessLogsPrefix(undefined)).toBeUndefined();
    expect(normalizeAccessLogsPrefix('')).toBeUndefined();
    expect(normalizeAccessLogsPrefix('/')).toBeUndefined();
  });

  it('rejects the reserved AWSLogs path segment', () => {
    expect(() => normalizeAccessLogsPrefix('alb/AWSLogs')).toThrow(
      /must not include "AWSLogs"/,
    );
  });
});

describe('buildAccessLogsBucketPolicy', () => {
  const options = {
    bucketArn: 'arn:aws:s3:::my-logs',
    accountId: '123456789012',
    region: 'us-east-1',
  };

  it('lets the log delivery service write for this account and region only', () => {
    const policy = buildAccessLogsBucketPolicy(options);

    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement).toEqual([
      {
        Sid: 'ElbLogDelivery',
        Effect: 'Allow',
        Principal: {
          Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
        },
        Action: 's3:PutObject',
        Resource: 'arn:aws:s3:::my-logs/AWSLogs/123456789012/*',
        Condition: {
          ArnLike: {
            'aws:SourceArn':
              'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/*',
          },
        },
      },
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: ['arn:aws:s3:::my-logs', 'arn:aws:s3:::my-logs/*'],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ]);
  });

  it('scopes the delivery grant to the normalized prefix', () => {
    const [grant] = buildAccessLogsBucketPolicy({
      ...options,
      prefix: '/alb/',
    }).Statement as Array<{ Resource: string }>;

    expect(grant.Resource).toBe(
      'arn:aws:s3:::my-logs/alb/AWSLogs/123456789012/*',
    );
  });

  it('uses the partition of the bucket', () => {
    const [grant] = buildAccessLogsBucketPolicy({
      bucketArn: 'arn:aws-us-gov:s3:::my-logs',
      accountId: '123456789012',
      region: 'us-gov-west-1',
    }).Statement as Array<{
      Resource: string;
      Condition: { ArnLike: Record<string, string> };
    }>;

    expect(grant.Resource).toBe(
      'arn:aws-us-gov:s3:::my-logs/AWSLogs/123456789012/*',
    );
    expect(grant.Condition.ArnLike['aws:SourceArn']).toBe(
      'arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:loadbalancer/*',
    );
  });
});
