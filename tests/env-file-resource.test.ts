import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toEnvFileContent } from '../src/dotenv';

const vault = vi.hoisted(() => ({ secrets: null as Record<string, string> | null }));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send() {
      if (!vault.secrets) {
        throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      }

      return { SecretString: JSON.stringify(vault.secrets) };
    }
  },
  GetSecretValueCommand: class {},
}));

import { buildEnvFileContent, envFileProvider, ResolvedEnvFileInputs } from '../src/env-file-resource';

const HEADER = '# --- SST-LARAVEL AUTO-INJECTED VARIABLES ---';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-env-'));

beforeEach(() => {
  vault.secrets = null;
});

describe('buildEnvFileContent', () => {
  const file = (content: string) => ({ content, variables: {} as Record<string, string> });

  it('keeps the env file as written and adds the injected variables, quoted', () => {
    const source = 'APP_KEY=base64:test\n# Mail\nMAIL_FROM_NAME="${APP_NAME}"\n\n';

    expect(buildEnvFileContent(file(source), {
      envFilePath: '/x',
      fingerprint: 'f',
      appUrl: 'https://example.com',
      linkedEnvironment: { DB_PASSWORD: 'p$ss #1', DB_HOST: 'db', SKIPPED: undefined },
      linkedSecrets: [{ name: 'STRIPE_SECRET', value: "it's secret" }],
    })).toBe([
      'APP_KEY=base64:test\n# Mail\nMAIL_FROM_NAME="${APP_NAME}"',
      HEADER,
      'APP_URL=https://example.com\nDB_HOST=db\nDB_PASSWORD=\'p$ss #1\'\nLOG_CHANNEL=stderr\nSTRIPE_SECRET="it\'s secret"\n',
    ].join('\n\n'));
  });

  it('leaves APP_URL and LOG_CHANNEL to the source when it sets them', () => {
    const content = buildEnvFileContent(
      { content: 'APP_URL=https://app.test\nLOG_CHANNEL=daily\n', variables: { APP_URL: 'https://app.test', LOG_CHANNEL: 'daily' } },
      { envFilePath: '/x', fingerprint: 'f', appUrl: 'https://example.com' },
    );

    expect(content).toBe('APP_URL=https://app.test\nLOG_CHANNEL=daily\n');
  });

  it('writes the source alone when autoInject is off', () => {
    expect(buildEnvFileContent(file('APP_KEY=x'), { envFilePath: '/x', fingerprint: 'f', autoInject: false, appUrl: 'https://example.com' }))
      .toBe('APP_KEY=x\n');
  });

  it('writes a RemoteEnvVault the way earlier versions did, so images are not rebuilt', () => {
    const secrets = { APP_KEY: 'base64:test', REDIS_PASSWORD: 'a$b' };

    expect(buildEnvFileContent(
      { content: toEnvFileContent(secrets), variables: secrets },
      { envFilePath: '/x', fingerprint: 'f', linkedEnvironment: { DB_HOST: 'db' } },
    )).toBe(`APP_KEY=base64:test\nREDIS_PASSWORD='a$b'\n\n${HEADER}\n\nDB_HOST=db\nLOG_CHANNEL=stderr\n`);
  });
});

describe('envFileProvider', () => {
  function fileInputs(): ResolvedEnvFileInputs {
    const dir = tempDir();
    const sourcePath = path.join(dir, '.env.production');
    fs.writeFileSync(sourcePath, 'APP_KEY=base64:test\n');

    return { envFilePath: path.join(dir, 'build/deploy/.env'), sourcePath, fingerprint: 'f', linkedEnvironment: { DB_HOST: 'db' } };
  }

  it('writes the env file, readable by its owner only', async () => {
    const inputs = fileInputs();

    await envFileProvider.create!(inputs);

    expect(fs.readFileSync(inputs.envFilePath, 'utf-8')).toBe(`APP_KEY=base64:test\n\n${HEADER}\n\nDB_HOST=db\nLOG_CHANNEL=stderr\n`);
    expect(fs.statSync(inputs.envFilePath).mode & 0o777).toBe(0o600);
  });

  it('rewrites the file when it is missing or differs, as in a fresh CI checkout', async () => {
    const inputs = fileInputs();
    await envFileProvider.create!(inputs);

    expect((await envFileProvider.diff!('id', inputs, inputs)).changes).toBe(false);

    fs.rmSync(inputs.envFilePath);
    expect((await envFileProvider.diff!('id', inputs, inputs)).changes).toBe(true);

    await envFileProvider.update!('id', inputs, inputs);
    fs.appendFileSync(inputs.sourcePath!, 'APP_DEBUG=false\n');
    expect((await envFileProvider.diff!('id', inputs, inputs)).changes).toBe(true);
  });

  it('starts from the RemoteEnvVault secrets', async () => {
    vault.secrets = { APP_KEY: 'base64:vault' };
    const envFilePath = path.join(tempDir(), '.env');

    await envFileProvider.create!({ envFilePath, secretPath: '/app/production/env', fingerprint: 'f', autoInject: false });

    expect(fs.readFileSync(envFilePath, 'utf-8')).toBe('APP_KEY=base64:vault\n');
  });

  it('fails the deploy when the RemoteEnvVault secret is missing', async () => {
    await expect(envFileProvider.create!({ envFilePath: path.join(tempDir(), '.env'), secretPath: '/app/production/env', fingerprint: 'f' }))
      .rejects.toThrow('RemoteEnvVault secret not found at /app/production/env.');
  });
});
