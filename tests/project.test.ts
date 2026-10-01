import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureGitIgnore,
  isGenericAppName,
  resolveAppName,
  resolvePhpVersion,
  slugify,
} from '../bin/utils/project';

const makeApp = (name: string, files: Record<string, string> = {}): string => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-project-')), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
};

describe('slugify and isGenericAppName', () => {
  it('turns names into lowercase slugs', () => {
    expect(slugify('"My Shop App"')).toBe('my-shop-app');
    expect(slugify('Laravel')).toBe('laravel');
  });

  it('knows the skeleton names', () => {
    expect(isGenericAppName('Laravel')).toBe(true);
    expect(isGenericAppName('laravel/laravel')).toBe(false);
    expect(isGenericAppName('my-shop')).toBe(false);
  });
});

describe('resolveAppName', () => {
  it('uses the composer project name when it is not the skeleton', () => {
    const app = makeApp('folder-name', {
      'composer.json': JSON.stringify({ name: 'kirschbaum/my-shop' }),
      '.env': 'APP_NAME=Laravel\n',
    });

    expect(resolveAppName(app)).toEqual({ name: 'my-shop', source: 'composer.json', generic: false });
  });

  it('falls back to the folder name for a fresh skeleton', () => {
    const app = makeApp('sst-laravel-06-test', {
      'composer.json': JSON.stringify({ name: 'laravel/laravel' }),
      '.env': 'APP_NAME=Laravel\n',
    });

    expect(resolveAppName(app)).toEqual({ name: 'sst-laravel-06-test', source: 'folder', generic: false });
  });

  it('flags a generic name when nothing better exists', () => {
    const app = makeApp('laravel', {
      'composer.json': JSON.stringify({ name: 'laravel/laravel' }),
      '.env': 'APP_NAME=Laravel\n',
    });

    const resolved = resolveAppName(app);
    expect(resolved.name).toBe('laravel');
    expect(resolved.generic).toBe(true);
  });
});

describe('resolvePhpVersion', () => {
  it('keeps the local version when the image supports it', () => {
    expect(resolvePhpVersion('8.5')).toBe('8.5');
    expect(resolvePhpVersion('8.2')).toBe('8.2');
  });

  it('falls back to the default otherwise', () => {
    expect(resolvePhpVersion('9.0')).toBe('8.4');
    expect(resolvePhpVersion(null)).toBe('8.4');
  });
});

describe('ensureGitIgnore', () => {
  it('appends missing entries once', () => {
    const app = makeApp('app', { '.gitignore': '/vendor\n.env\n' });

    expect(ensureGitIgnore(app, ['.sst'])).toEqual(['.sst']);
    expect(fs.readFileSync(path.join(app, '.gitignore'), 'utf-8')).toBe('/vendor\n.env\n\n# sst\n.sst\n');
    expect(ensureGitIgnore(app, ['.sst'])).toEqual([]);
  });

  it('treats a trailing slash as the same entry and creates the file when missing', () => {
    const app = makeApp('app', { '.gitignore': '.sst/\n' });
    expect(ensureGitIgnore(app, ['.sst'])).toEqual([]);

    const fresh = makeApp('fresh');
    expect(ensureGitIgnore(fresh, ['.sst'])).toEqual(['.sst']);
    expect(fs.readFileSync(path.join(fresh, '.gitignore'), 'utf-8')).toBe('\n# sst\n.sst\n');
  });
});
