import { describe, expect, it } from 'vitest';
import {
  buildServiceArgs,
  composeTransform,
  composeTransforms,
  findDeprecatedTopLevelKeys,
  resolveAdvancedArgs,
} from '../src/service-args';

describe('buildServiceArgs', () => {
  it('returns an empty object when no config is given', () => {
    expect(buildServiceArgs()).toEqual({});
    expect(buildServiceArgs({})).toEqual({});
  });

  it('forwards the first-class cpu, memory and permissions args', () => {
    expect(
      buildServiceArgs({
        cpu: '1 vCPU',
        memory: '2 GB',
        permissions: [{ actions: ['s3:GetObject'], resources: ['*'] }],
      }),
    ).toEqual({
      cpu: '1 vCPU',
      memory: '2 GB',
      permissions: [{ actions: ['s3:GetObject'], resources: ['*'] }],
    });
  });

  it('omits keys that were not set instead of forwarding undefined', () => {
    const result = buildServiceArgs({ cpu: '2 vCPU' });

    expect(result).toEqual({ cpu: '2 vCPU' });
    expect(result).not.toHaveProperty('memory');
  });

  it('ignores advanced keys set directly on the block', () => {
    expect(
      buildServiceArgs({
        cpu: '1 vCPU',
        scaling: { min: 2, max: 4 },
        loadBalancer: {},
        architecture: 'arm64',
      } as Record<string, unknown>),
    ).toEqual({ cpu: '1 vCPU' });
  });
});

describe('resolveAdvancedArgs', () => {
  it('returns an empty object when no config is given', () => {
    expect(resolveAdvancedArgs()).toEqual({});
    expect(resolveAdvancedArgs({})).toEqual({});
  });

  it('reads values from the advanced block', () => {
    expect(
      resolveAdvancedArgs({
        advanced: { architecture: 'arm64', storage: '30 GB' },
      }),
    ).toEqual({ architecture: 'arm64', storage: '30 GB' });
  });

  it('keeps deprecated top-level keys working', () => {
    expect(resolveAdvancedArgs({ architecture: 'arm64' })).toEqual({
      architecture: 'arm64',
    });
  });

  it('prefers advanced values over deprecated top-level keys', () => {
    expect(
      resolveAdvancedArgs({
        architecture: 'x86_64',
        advanced: { architecture: 'arm64' },
      }),
    ).toEqual({ architecture: 'arm64' });
  });

  it('ignores first-class keys', () => {
    expect(resolveAdvancedArgs({ cpu: '1 vCPU' } as never)).toEqual({});
  });

  it('only reads the load balancer config from the advanced block', () => {
    const rules = [{ listen: '80/http', forward: '8080/http' }];

    expect(
      resolveAdvancedArgs({
        loadBalancer: { accessLogs: true },
        advanced: { loadBalancer: { rules } },
      } as never),
    ).toEqual({ loadBalancer: { rules } });

    expect(
      resolveAdvancedArgs({ loadBalancer: { accessLogs: true } } as never),
    ).toEqual({});
  });
});

describe('findDeprecatedTopLevelKeys', () => {
  it('returns an empty list when nothing deprecated is used', () => {
    expect(findDeprecatedTopLevelKeys()).toEqual([]);
    expect(findDeprecatedTopLevelKeys({ cpu: '1 vCPU' })).toEqual([]);
  });

  it('lists deprecated keys set directly on the block', () => {
    expect(
      findDeprecatedTopLevelKeys({
        architecture: 'arm64',
        storage: '30 GB',
      }),
    ).toEqual(['architecture', 'storage']);
  });

  it('does not treat the load balancer options as deprecated', () => {
    expect(
      findDeprecatedTopLevelKeys({
        loadBalancer: { accessLogs: true },
      } as never),
    ).toEqual([]);
  });
});

describe('composeTransform', () => {
  const internal = (args: Record<string, unknown>) => {
    args.networkConfiguration = 'internal';
  };

  it('runs only the internal transform when the user has none', () => {
    const args: Record<string, unknown> = {};
    composeTransform(internal)(args, {}, 'Web');

    expect(args).toEqual({ networkConfiguration: 'internal' });
  });

  it('runs a user function after the internal transform', () => {
    const args: Record<string, unknown> = {};
    const user = (a: Record<string, unknown>, _opts: unknown, name: string) => {
      a.seen = a.networkConfiguration;
      a.name = name;
    };

    composeTransform(internal, user)(args, {}, 'Web');

    expect(args).toEqual({
      networkConfiguration: 'internal',
      seen: 'internal',
      name: 'Web',
    });
  });

  it('merges a user object over the internal changes', () => {
    const args: Record<string, unknown> = { desiredCount: 1 };

    composeTransform(internal, {
      networkConfiguration: 'user',
      enableExecuteCommand: true,
    })(args, {}, 'Web');

    expect(args).toEqual({
      desiredCount: 1,
      networkConfiguration: 'user',
      enableExecuteCommand: true,
    });
  });
});

describe('composeTransforms', () => {
  it('keeps keys that only exist on one side', () => {
    const listener = () => {};
    const target = () => {};

    const composed = composeTransforms({ listener }, { target });

    expect(composed.listener).toBe(listener);
    expect(composed.target).toBe(target);
  });

  it('returns the internal transforms when the user has none', () => {
    const listener = () => {};

    expect(composeTransforms({ listener })).toEqual({ listener });
    expect(composeTransforms({}, undefined)).toEqual({});
  });

  it('runs the internal transform before the user one for the same key', () => {
    const order: string[] = [];

    const composed = composeTransforms(
      { listener: () => order.push('internal') },
      { listener: () => order.push('user') },
    );

    (composed.listener as Function)({}, {}, 'Listener');

    expect(order).toEqual(['internal', 'user']);
  });

  it('lets a user object override what the internal transform set', () => {
    const composed = composeTransforms(
      {
        listener: (args: Record<string, unknown>) => {
          args.sslPolicy = 'internal-policy';
          args.port = 443;
        },
      },
      { listener: { sslPolicy: 'user-policy' } },
    );

    const args: Record<string, unknown> = {};
    (composed.listener as Function)(args, {}, 'Listener');

    expect(args).toEqual({ sslPolicy: 'user-policy', port: 443 });
  });
});
