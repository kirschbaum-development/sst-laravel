import { describe, expect, it } from 'vitest';
import {
  buildServiceArgs,
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
        loadBalancer: {},
      }),
    ).toEqual(['architecture', 'loadBalancer']);
  });
});
