import { describe, expect, it } from 'vitest';
import { buildImage, managedImageTransform } from '../src/image';
import type { CustomResourceOptions, Resource } from '@pulumi/pulumi';

const options = {
  sitePath: '.',
  absSitePath: '/app',
  packagePath: '/app/node_modules/@kirschbaum-development/sst-laravel',
  servicesPath: '/app/.sst/laravel/web',
  deployPath: '/app/.sst/laravel/deploy',
};

describe('buildImage', () => {
  it('builds the deploy stage of the role Dockerfile from the app folder', () => {
    const image = buildImage({ ...options, role: 'web' });

    expect(image.context).toBe('.');
    expect(image.dockerfile).toBe('./node_modules/@kirschbaum-development/sst-laravel/Dockerfile.web');
    expect(image.target).toBe('deploy');
  });

  it('passes the paths relative to the app folder', () => {
    const image = buildImage({ ...options, role: 'worker', confPath: '/app/.sst/laravel/conf' });

    expect(image.args).toMatchObject({
      PHP_VERSION: '8.4',
      CONF_PATH: '/.sst/laravel/conf',
      CUSTOM_CONF_PATH: '/.sst/laravel/web',
      DEPLOY_PATH: '/.sst/laravel/deploy',
    });
  });

  it('uses the configured PHP version', () => {
    expect(buildImage({ ...options, role: 'web', php: 8.3 }).args.PHP_VERSION).toBe('8.3');
  });

  it.each([
    [undefined, '1'],
    [true, '1'],
    [false, '0'],
  ])('sets PHP_OPCACHE_ENABLE for opcache %s', async (opcache, expected) => {
    const value = await new Promise((resolve) =>
      buildImage({ ...options, role: 'web', opcache }).args.PHP_OPCACHE_ENABLE.apply(resolve),
    );

    expect(value).toBe(expected);
  });
});

describe('managed image lifecycle', () => {
  it('keeps function transforms, resource options, and dependencies', () => {
    const env = {} as Resource;
    const dependency = {} as Resource;
    const args: Record<string, unknown> = { push: true };
    const opts: CustomResourceOptions = { dependsOn: [dependency], protect: true };
    const user = (image: Record<string, unknown>, options: CustomResourceOptions, name: string) => {
      image.labels = { name };
      options.customTimeouts = { create: '30m' };
    };
    managedImageTransform(env, user)(args, opts, 'Image');
    expect(args).toEqual({ push: true, labels: { name: 'Image' } });
    expect(opts).toMatchObject({ retainOnDelete: true, protect: true, dependsOn: [dependency, env], customTimeouts: { create: '30m' } });
  });

  it('preserves object transforms and an explicit retention override', () => {
    const args = {};
    const opts: CustomResourceOptions = { retainOnDelete: false };
    managedImageTransform(undefined, { buildOnPreview: false })(args, opts, 'Image');
    expect(args).toEqual({ buildOnPreview: false });
    expect(opts.retainOnDelete).toBe(false);
  });
});
