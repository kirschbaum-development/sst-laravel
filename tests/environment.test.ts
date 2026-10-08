import { describe, expect, it } from 'vitest';
import { Output, output } from '@pulumi/pulumi';
import { buildContainerEnvironment, buildReverbEnvironment, getAppUrl, getDomainName } from '../src/environment';
import { resolveReverbArgs } from '../src/services';

const resolve = <T>(value: unknown): Promise<T> =>
  new Promise((done) => (Output.isInstance(value) ? (value as Output<T>).apply(done) : done(value as T)));

describe('getDomainName and getAppUrl', () => {
  it('keep a plain domain a string', () => {
    expect(getDomainName('example.com')).toBe('example.com');
    expect(getAppUrl('example.com')).toBe('https://example.com');
  });

  it('resolve a domain object', async () => {
    expect(await resolve(getAppUrl({ name: output('example.com') }))).toBe('https://example.com');
    expect(await resolve(getAppUrl({ name: '' }))).toBeUndefined();
  });

  it('return undefined without a domain', () => {
    expect(getDomainName(undefined)).toBeUndefined();
    expect(getAppUrl(undefined)).toBeUndefined();
  });
});

describe('buildReverbEnvironment', () => {
  it('adds the public host when Reverb has a domain', () => {
    expect(buildReverbEnvironment(resolveReverbArgs({ domain: 'ws.example.com' }))).toEqual({
      REVERB_SERVER_HOST: '0.0.0.0',
      REVERB_SERVER_PORT: '8080',
      REVERB_HOST: 'ws.example.com',
      REVERB_PORT: '443',
      REVERB_SCHEME: 'https',
    });
  });

  it('is empty without Reverb', () => {
    expect(buildReverbEnvironment(undefined)).toEqual({});
  });
});

describe('buildContainerEnvironment', () => {
  it('merges the injected variables, vars, and the service variables, in that order', async () => {
    const environment = buildContainerEnvironment(
      { A: 'injected', B: 'injected' },
      output({ B: 'vars', C: 'vars' }),
      { C: 'service' },
    );

    expect(await resolve(environment)).toEqual({ A: 'injected', B: 'vars', C: 'service' });
  });

  it('leaves out variables without a value', async () => {
    expect(await resolve(buildContainerEnvironment({ A: undefined, B: 'b' }, undefined, {}))).toEqual({ B: 'b' });
  });
});
