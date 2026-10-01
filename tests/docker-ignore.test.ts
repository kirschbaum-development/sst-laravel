import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDockerIgnoreContent,
  DOCKER_IGNORE_DEFAULTS,
  ensureDockerIgnore,
  resolveDockerIgnorePath,
} from '../src/docker-ignore';

const makeContext = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-dockerignore-'));

describe('buildDockerIgnoreContent', () => {
  it('writes the safe defaults plus the .sst lines when there is no file', () => {
    const content = buildDockerIgnoreContent(null);

    expect(content).toContain('.git\n');
    expect(content).toContain('node_modules\n');
    expect(content).toContain('.env.*\n');
    expect(content).toContain('database/*.sqlite\n');
    expect(content?.endsWith('# sst\n.sst\n\n# sst-laravel\n!.sst/laravel\n')).toBe(true);
  });

  it('only appends the .sst lines to an existing file', () => {
    const content = buildDockerIgnoreContent('vendor/bin\n');

    expect(content).toBe('vendor/bin\n\n# sst\n.sst\n\n# sst-laravel\n!.sst/laravel\n');
    expect(content).not.toContain('node_modules');
  });

  it('returns null when the file is already up to date', () => {
    const upToDate = buildDockerIgnoreContent('vendor/bin\n') as string;

    expect(buildDockerIgnoreContent(upToDate)).toBeNull();
    expect(buildDockerIgnoreContent(buildDockerIgnoreContent(null) as string)).toBeNull();
  });

  it('moves stray .sst lines to the end instead of duplicating them', () => {
    const content = buildDockerIgnoreContent('.sst\nvendor/bin\n!.sst/laravel\n');

    expect(content?.match(/^\.sst$/gm)).toHaveLength(1);
    expect(content?.match(/^!\.sst\/laravel$/gm)).toHaveLength(1);
  });
});

describe('ensureDockerIgnore', () => {
  it('creates the file with defaults and reports it', () => {
    const context = makeContext();

    const message = ensureDockerIgnore(context, 'Dockerfile.web');

    expect(message).toContain('Created');
    expect(fs.readFileSync(path.join(context, '.dockerignore'), 'utf-8')).toContain(
      DOCKER_IGNORE_DEFAULTS.split('\n')[2],
    );
  });

  it('keeps an existing file and adds only the .sst lines', () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context, '.dockerignore'), 'node_modules\n');

    const message = ensureDockerIgnore(context, 'Dockerfile.web');

    expect(message).toContain('Updated');
    const content = fs.readFileSync(path.join(context, '.dockerignore'), 'utf-8');
    expect(content.startsWith('node_modules\n')).toBe(true);
    expect(content).not.toContain('.env.*');
    expect(ensureDockerIgnore(context, 'Dockerfile.web')).toBeNull();
  });

  it('prefers a Dockerfile-specific ignore file when it exists', () => {
    const context = makeContext();
    fs.writeFileSync(path.join(context, 'Dockerfile.web.dockerignore'), '');

    expect(resolveDockerIgnorePath(context, 'Dockerfile.web')).toBe(
      path.join(context, 'Dockerfile.web.dockerignore'),
    );
    expect(resolveDockerIgnorePath(context, 'Dockerfile.worker')).toBe(
      path.join(context, '.dockerignore'),
    );
  });
});
