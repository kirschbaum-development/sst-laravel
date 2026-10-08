import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSecretsConfig, extractSstProjectName, resolveVaultSecretPath, stripTsComments } from '../bin/utils/sst-config';

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-test-'));
  const filePath = path.join(dir, 'sst.config.ts');
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('stripTsComments', () => {
  it('removes line and block comments', () => {
    const content = [
      'const a = 1; // trailing comment',
      '// full line comment',
      '/* block comment */',
      'const b = 2;',
    ].join('\n');

    const stripped = stripTsComments(content);

    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
    expect(stripped).not.toContain('comment');
  });
});

describe('extractSecretsConfig', () => {
  it('returns null when RemoteEnvVault is only mentioned in comments', () => {
    const configPath = writeTempConfig(`
      // const { RemoteEnvVault } = await import("@kirschbaum-development/sst-laravel");
      // const env = new RemoteEnvVault("Env");
      const app = new LaravelService("App", {
        config: {
          environment: {
            file: ".env.dev",
            // secrets: env,
          },
        },
      });
    `);

    expect(extractSecretsConfig(configPath)).toBeNull();
  });

  it('detects an active RemoteEnvVault with secrets', () => {
    const configPath = writeTempConfig(`
      const env = new RemoteEnvVault("Env");
      const app = new LaravelService("App", {
        config: {
          environment: {
            secrets: env,
          },
        },
      });
    `);

    expect(extractSecretsConfig(configPath)).toEqual({ path: undefined });
  });
});

describe('resolveVaultSecretPath', () => {
  const resolve = (content: string) => resolveVaultSecretPath(writeTempConfig(content), 'my-app', 'production');

  it('uses the default path without a RemoteEnvVault', () => {
    expect(resolve('new LaravelService("App", {});')).toBe('/my-app/production/env');
  });

  it('uses the default path when the vault sets no path', () => {
    expect(resolve('const env = new RemoteEnvVault("Env");')).toBe('/my-app/production/env');
    expect(resolve('const env = new RemoteEnvVault(name, {});')).toBe('/my-app/production/env');
  });

  it('uses the path the vault sets', () => {
    expect(resolve(`const env = new RemoteEnvVault("Env", { path: "/custom/path/env" });`)).toBe('/custom/path/env');
    expect(resolve(`const env = new RemoteEnvVault('Env', {\n  path: '/custom/path/env',\n});`)).toBe('/custom/path/env');
  });

  it('fills in $app.name and $app.stage in a template literal', () => {
    expect(resolve('const env = new RemoteEnvVault("Env", { path: `/${$app.name}/${ $app.stage }/secrets` });'))
      .toBe('/my-app/production/secrets');
  });

  it('keeps ${...} in a plain string, which JavaScript does not interpolate', () => {
    expect(resolve('const env = new RemoteEnvVault("Env", { path: "/x/${$app.stage}" });')).toBe('/x/${$app.stage}');
  });

  it('ignores a vault that is commented out', () => {
    expect(resolve(`
      // const env = new RemoteEnvVault("Env", { path: "/old/path" });
      const env = new RemoteEnvVault("Env");
    `)).toBe('/my-app/production/env');
  });

  it.each([
    ['a computed path', 'new RemoteEnvVault("Env", { path: "/x/" + $app.stage });'],
    ['a path from a variable', 'new RemoteEnvVault("Env", { path: vaultPath });'],
    ['a shorthand path', 'new RemoteEnvVault("Env", { path });'],
    ['options from a variable', 'new RemoteEnvVault("Env", vaultArgs);'],
    ['other template values', 'new RemoteEnvVault("Env", { path: `/${process.env.TEAM}/env` });'],
  ])('asks for --path instead of guessing with %s', (_, content) => {
    expect(() => resolve(content)).toThrow('--path');
  });

  it('asks for --path when vaults use different paths', () => {
    expect(() => resolve(`
      new RemoteEnvVault("Env", { path: "/a/env" });
      new RemoteEnvVault("Other");
    `)).toThrow('--path');
  });
});

describe('extractSstProjectName', () => {
  const name = (content: string) => extractSstProjectName(writeTempConfig(content));

  it('reads the name app() returns, not an earlier one', () => {
    expect(name(`
      const workers = [{ name: "queue" }];
      export default $config({
        app(input) {
          return { name: "shop", home: "aws" };
        },
        async run() {},
      });
    `)).toBe('shop');
  });

  it('ignores comments and keys that end in "name"', () => {
    expect(name(`
      // name: "old-name"
      const filename: "x.txt";
      export default $config({ app: (input) => ({ name: 'shop' }) });
    `)).toBe('shop');
  });

  it('falls back to the first name without an app() function', () => {
    expect(name('export default { name: "shop" };')).toBe('shop');
  });
});
