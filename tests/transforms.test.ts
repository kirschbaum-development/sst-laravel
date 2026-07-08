import { describe, expect, it } from 'vitest';
import { chainTransforms, mergeServiceTransforms } from '../src/transforms';

interface FakeArgs {
  sslPolicy?: string;
  tags?: Record<string, string>;
}

describe('chainTransforms', () => {
  it('returns the other transform when one side is undefined', () => {
    const fn = () => {};

    expect(chainTransforms(fn, undefined)).toBe(fn);
    expect(chainTransforms(undefined, fn)).toBe(fn);
    expect(chainTransforms(undefined, undefined)).toBeUndefined();
  });

  it('runs the first transform before the second so the second wins', () => {
    const chained = chainTransforms<FakeArgs>(
      (args) => {
        args.sslPolicy = 'package-policy';
        args.tags = { managedBy: 'package' };
      },
      (args) => {
        args.sslPolicy = 'user-policy';
      },
    );

    const args: FakeArgs = {};
    (chained as Function)(args, {}, 'Listener');

    expect(args.sslPolicy).toBe('user-policy');
    expect(args.tags).toEqual({ managedBy: 'package' });
  });

  it('shallow-merges object-form transforms over the args', () => {
    const chained = chainTransforms<FakeArgs>(
      (args) => {
        args.sslPolicy = 'package-policy';
      },
      { sslPolicy: 'user-policy' },
    );

    const args: FakeArgs = {};
    (chained as Function)(args, {}, 'Listener');

    expect(args.sslPolicy).toBe('user-policy');
  });

  it('passes opts and name through to function transforms', () => {
    const seen: unknown[] = [];
    const chained = chainTransforms<FakeArgs>(
      (_args, opts, name) => seen.push(opts, name),
      (_args, opts, name) => seen.push(opts, name),
    );

    const opts = { dependsOn: [] };
    (chained as Function)({}, opts, 'Listener');

    expect(seen).toEqual([opts, 'Listener', opts, 'Listener']);
  });
});

describe('mergeServiceTransforms', () => {
  it('keeps keys that only exist on one side', () => {
    const listener = () => {};
    const loadBalancer = () => {};

    const merged = mergeServiceTransforms(
      { listener },
      { loadBalancer },
    );

    expect(merged.listener).toBe(listener);
    expect(merged.loadBalancer).toBe(loadBalancer);
  });

  it('chains keys present on both sides, base first', () => {
    const order: string[] = [];

    const merged = mergeServiceTransforms(
      { listener: () => order.push('package') },
      { listener: () => order.push('user') },
    );

    (merged.listener as Function)({}, {}, 'Listener');

    expect(order).toEqual(['package', 'user']);
  });

  it('handles undefined transform maps', () => {
    expect(mergeServiceTransforms(undefined, undefined)).toEqual({});

    const listener = () => {};
    expect(mergeServiceTransforms({ listener }, undefined).listener).toBe(
      listener,
    );
  });
});
