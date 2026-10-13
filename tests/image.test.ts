import { describe, expect, it } from 'vitest';
import { buildImage, managedImageTransform, serializeBuildCommands, serializePhpExtensions } from '../src/image';
import { output, type CustomResourceOptions, type Resource } from '@pulumi/pulumi';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

  it('leaves customization args unset when the options are omitted', () => {
    const { args } = buildImage({ ...options, role: 'web' });
    expect(args).not.toHaveProperty('PHP_EXTENSIONS');
    expect(args).not.toHaveProperty('BUILD_COMMANDS');
  });

  it.each(['web', 'worker'] as const)('resolves customization Inputs for the %s image', async (role) => {
    const image = buildImage({
      ...options,
      role,
      phpExtensions: output(['imagick', 'pdo_pgsql']),
      buildCommands: Promise.resolve(['printf "%s" "it\'s working"']),
    });
    const args = await new Promise<Record<string, string>>((resolve) => output(image.args).apply(resolve));
    expect(args.PHP_EXTENSIONS).toBe('imagick pdo_pgsql');
    expect(spawnSync('/bin/sh', ['-c', args.BUILD_COMMANDS], { encoding: 'utf8' }).stdout).toBe("it's working");
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

describe('image customization', () => {
  it('accepts extension names and removes duplicates', () => {
    expect(serializePhpExtensions(['imagick', 'pdo_pgsql', 'imagick'])).toBe('imagick pdo_pgsql');
    expect(serializePhpExtensions([])).toBe('');
  });

  it.each(['', 'gd intl', '--help', 'imagick; true', '$(true)', 'foo*', 'intl\nRUN true'])('rejects an invalid extension name %j', (name) => {
    expect(() => serializePhpExtensions([name])).toThrow('config.phpExtensions');
  });

  it.each(['', '  \n', 'echo\0hello'])('rejects invalid build commands without echoing their contents', (command) => {
    expect(() => serializeBuildCommands([command])).toThrow('config.buildCommands must be an array');
  });

  it('preserves quotes, multiline scripts, shell variables, and literal Dockerfile text', () => {
    const command = `value="it's working"
printf '%s\\n' "$value" 'literal $HOME' 'literal \`hostname\`'
cat <<'END'
RUN echo this is text
END`;
    const result = spawnSync('/bin/sh', ['-c', serializeBuildCommands([command])], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("it's working\nliteral $HOME\nliteral `hostname`\nRUN echo this is text\n");
  });

  it('runs entries in separate shells while preserving their filesystem changes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-build-'));
    try {
      const result = spawnSync('/bin/sh', ['-c', serializeBuildCommands([
        'export SST_LARAVEL_TEST_LOCAL=yes; mkdir child; cd child; printf first > marker',
        'test -z "${SST_LARAVEL_TEST_LOCAL:-}" && cat child/marker',
      ])], { cwd, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('first');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('stops on a failed entry, preserving its exit status', () => {
    const result = spawnSync('/bin/sh', ['-c', serializeBuildCommands(['exit 42', 'printf should-not-run'])], { encoding: 'utf8' });
    expect(result.status).toBe(42);
    expect(result.stdout).toBe('');
  });

  it('continues after an entry exits successfully and accepts an empty list', () => {
    expect(spawnSync('/bin/sh', ['-c', serializeBuildCommands(['exit 0', 'printf next'])], { encoding: 'utf8' }).stdout).toBe('next');
    expect(spawnSync('/bin/sh', ['-c', serializeBuildCommands([])]).status).toBe(0);
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
