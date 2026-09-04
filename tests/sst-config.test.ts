import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSecretsConfig, stripTsComments } from '../bin/utils/sst-config';

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
