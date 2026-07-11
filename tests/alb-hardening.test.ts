import { describe, expect, it } from 'vitest';
import {
  buildAccessLogsBucketPolicy,
  buildIngressRules,
  extractListenPorts,
  getElbAccessLogsAccountArn,
  getStaticListenPorts,
  normalizeAccessLogsPrefix,
  resolveListenerSslPolicy,
} from '../src/alb-hardening';
import { buildDefaultPublicPorts } from '../src/load-balancer';

const SSL_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06';

describe('resolveListenerSslPolicy', () => {
  it('applies the policy to HTTPS listeners', () => {
    expect(resolveListenerSslPolicy('HTTPS', SSL_POLICY)).toBe(SSL_POLICY);
  });

  it('applies the policy to TLS listeners', () => {
    expect(resolveListenerSslPolicy('TLS', SSL_POLICY)).toBe(SSL_POLICY);
  });

  it('matches the protocol case-insensitively', () => {
    expect(resolveListenerSslPolicy('https', SSL_POLICY)).toBe(SSL_POLICY);
  });

  it('skips plain HTTP listeners, which reject SSL policies', () => {
    expect(resolveListenerSslPolicy('HTTP', SSL_POLICY)).toBeUndefined();
  });

  it('skips TCP and UDP listeners', () => {
    expect(resolveListenerSslPolicy('TCP', SSL_POLICY)).toBeUndefined();
    expect(resolveListenerSslPolicy('UDP', SSL_POLICY)).toBeUndefined();
  });

  it('returns undefined when the protocol or the policy is missing', () => {
    expect(resolveListenerSslPolicy(undefined, SSL_POLICY)).toBeUndefined();
    expect(resolveListenerSslPolicy('HTTPS', undefined)).toBeUndefined();
  });
});

describe('extractListenPorts', () => {
  it('extracts the listen ports from the default domain port mapping', () => {
    expect(
      extractListenPorts(buildDefaultPublicPorts({ hasDomain: true })),
    ).toEqual([80, 443]);
  });

  it('extracts a single port when no domain is configured', () => {
    expect(
      extractListenPorts(buildDefaultPublicPorts({ hasDomain: false })),
    ).toEqual([80]);
  });

  it('deduplicates repeated listen ports', () => {
    expect(
      extractListenPorts([
        { listen: '443/https', forward: '8080/http' },
        { listen: '443/https', forward: '9090/http' },
      ]),
    ).toEqual([443]);
  });
});

describe('getStaticListenPorts', () => {
  it('extracts ports from a plain load balancer config', () => {
    expect(
      getStaticListenPorts({
        ports: [
          { listen: '80/http', redirect: '443/https' },
          { listen: '443/https', forward: '8080/http' },
        ],
      }),
    ).toEqual([80, 443]);
  });

  it('returns undefined for non-object configs', () => {
    expect(getStaticListenPorts(undefined)).toBeUndefined();
    expect(getStaticListenPorts('lb')).toBeUndefined();
  });

  it('returns undefined when ports are not a statically-known array', () => {
    expect(getStaticListenPorts({})).toBeUndefined();
    expect(getStaticListenPorts({ ports: 'later' })).toBeUndefined();
  });

  it('returns undefined when a port entry is not statically known', () => {
    expect(
      getStaticListenPorts({
        ports: [{ listen: '80/http' }, { listen: 443 }],
      }),
    ).toBeUndefined();
  });
});

describe('buildIngressRules', () => {
  const v4 = ['173.245.48.0/20', '103.21.244.0/22'];
  const v6 = ['2400:cb00::/32'];

  it('builds one TCP rule per listen port with both CIDR families', () => {
    expect(buildIngressRules([80, 443], { v4, v6 })).toEqual([
      {
        description: 'Managed by SST Laravel (ingressCidrs)',
        protocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        cidrBlocks: v4,
        ipv6CidrBlocks: v6,
      },
      {
        description: 'Managed by SST Laravel (ingressCidrs)',
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: v4,
        ipv6CidrBlocks: v6,
      },
    ]);
  });

  it('omits the CIDR family that has no blocks', () => {
    const [rule] = buildIngressRules([443], { v4 });

    expect(rule.cidrBlocks).toEqual(v4);
    expect(rule).not.toHaveProperty('ipv6CidrBlocks');

    const [v6Rule] = buildIngressRules([443], { v6 });

    expect(v6Rule.ipv6CidrBlocks).toEqual(v6);
    expect(v6Rule).not.toHaveProperty('cidrBlocks');
  });

  it('throws when no CIDR blocks are given', () => {
    expect(() => buildIngressRules([443], {})).toThrow(
      /at least one IPv4 or IPv6 CIDR/,
    );
    expect(() => buildIngressRules([443], { v4: [], v6: [] })).toThrow(
      /at least one IPv4 or IPv6 CIDR/,
    );
  });

  it('throws when no listen ports could be determined', () => {
    expect(() => buildIngressRules([], { v4 })).toThrow(
      /could not determine any listen ports/,
    );
  });
});

describe('getElbAccessLogsAccountArn', () => {
  it('returns the regional log-delivery account for pre-2022 regions', () => {
    expect(getElbAccessLogsAccountArn('us-east-1')).toBe(
      'arn:aws:iam::127311923021:root',
    );
    expect(getElbAccessLogsAccountArn('eu-west-1')).toBe(
      'arn:aws:iam::156460612806:root',
    );
  });

  it('uses the matching partition for GovCloud and China regions', () => {
    expect(getElbAccessLogsAccountArn('us-gov-west-1')).toBe(
      'arn:aws-us-gov:iam::048591011584:root',
    );
    expect(getElbAccessLogsAccountArn('cn-north-1')).toBe(
      'arn:aws-cn:iam::638102146993:root',
    );
  });

  it('returns undefined for regions launched after August 2022', () => {
    expect(getElbAccessLogsAccountArn('ap-southeast-4')).toBeUndefined();
    expect(getElbAccessLogsAccountArn('il-central-1')).toBeUndefined();
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

  it('grants both the regional ELB account and the log-delivery service', () => {
    const policy = buildAccessLogsBucketPolicy(options);

    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement).toEqual([
      {
        Sid: 'ElbRegionalAccountLogDelivery',
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::127311923021:root' },
        Action: 's3:PutObject',
        Resource: 'arn:aws:s3:::my-logs/AWSLogs/123456789012/*',
      },
      {
        Sid: 'ElbLogDeliveryService',
        Effect: 'Allow',
        Principal: {
          Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
        },
        Action: 's3:PutObject',
        Resource: 'arn:aws:s3:::my-logs/AWSLogs/123456789012/*',
      },
    ]);
  });

  it('scopes the resource to the normalized prefix', () => {
    const policy = buildAccessLogsBucketPolicy({
      ...options,
      prefix: '/alb/',
    });

    for (const statement of policy.Statement as Array<{ Resource: string }>) {
      expect(statement.Resource).toBe(
        'arn:aws:s3:::my-logs/alb/AWSLogs/123456789012/*',
      );
    }
  });

  it('only grants the service principal in post-2022 regions', () => {
    const policy = buildAccessLogsBucketPolicy({
      ...options,
      region: 'il-central-1',
    });

    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]).toMatchObject({
      Principal: {
        Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
      },
    });
  });
});
