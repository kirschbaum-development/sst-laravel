import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envValue, isGitIgnored, secretEnvFiles } from '../bin/commands/doctor';

const makeRepo = (gitignore: string, files: string[] = []): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-doctor-'));
  execSync('git init -q', { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file), 'APP_KEY=\n');
  }
  return dir;
};

describe('isGitIgnored', () => {
  it('asks git about the real file, so .env.production does not cover .env.dev', () => {
    // Laravel's default .gitignore
    const repo = makeRepo('.env\n.env.backup\n.env.production\n');

    expect(isGitIgnored(repo, '.env')).toBe(true);
    expect(isGitIgnored(repo, '.env.production')).toBe(true);
    expect(isGitIgnored(repo, '.env.dev')).toBe(false);
  });

  it('works for files that do not exist yet and honours negations', () => {
    const repo = makeRepo('.env.*\n!.env.example\n');

    expect(isGitIgnored(repo, '.env.staging')).toBe(true);
    expect(isGitIgnored(repo, '.env.example')).toBe(false);
  });

  it('returns null outside a git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-nogit-'));

    expect(isGitIgnored(dir, '.env.dev')).toBeNull();
  });
});

describe('secretEnvFiles', () => {
  it('lists the env files on disk plus the stage file, without the example', () => {
    const repo = makeRepo('', ['.env', '.env.example', '.env.production']);

    expect(secretEnvFiles(repo, '.env.dev')).toEqual(['.env', '.env.dev', '.env.production']);
    expect(secretEnvFiles(repo, null)).toEqual(['.env', '.env.production']);
  });
});

describe('envValue', () => {
  it('reads a value and strips quotes', () => {
    expect(envValue('DB_CONNECTION="sqlite"\nAPP_DEBUG=true\n', 'DB_CONNECTION')).toBe('sqlite');
    expect(envValue('APP_KEY=\n', 'APP_KEY')).toBeNull();
  });
});
