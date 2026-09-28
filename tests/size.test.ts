import { describe, expect, it } from 'vitest';
import { buildSizeDefaults, SERVICE_SIZES } from '../src/size';

describe('buildSizeDefaults', () => {
  it('returns an empty object when no size is set', () => {
    expect(buildSizeDefaults()).toEqual({});
    expect(buildSizeDefaults({})).toEqual({});
    expect(buildSizeDefaults({ cpu: '1 vCPU' })).toEqual({});
  });

  it('maps each size to a valid cpu/memory pair', () => {
    for (const [size, defaults] of Object.entries(SERVICE_SIZES)) {
      expect(buildSizeDefaults({ size })).toEqual({ ...defaults });
    }
  });

  it('lets explicit cpu/memory win over size', () => {
    expect(
      buildSizeDefaults({ size: 'small', cpu: '2 vCPU' }),
    ).toEqual({ memory: '1 GB' });

    expect(
      buildSizeDefaults({ size: 'small', cpu: '2 vCPU', memory: '4 GB' }),
    ).toEqual({});
  });

  it('throws a helpful error for unknown sizes', () => {
    expect(() => buildSizeDefaults({ size: 'huge' })).toThrow(
      'Invalid size "huge". Use one of: small, medium, large.',
    );
  });
});
