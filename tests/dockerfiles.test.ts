import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildImage } from '../src/image';

interface Stage {
  /** The image or stage it starts from. */
  from: string;
  args: string[];
  /** Stages it copies files from. */
  copiesFrom: string[];
}

function parseDockerfile(dockerfile: string) {
  const content = fs.readFileSync(path.resolve(__dirname, '..', dockerfile), 'utf-8');
  const globalArgs: string[] = [];
  const stages: Record<string, Stage> = {};
  let stage: Stage | undefined;

  for (const line of content.split('\n')) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    const arg = line.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const copyFrom = line.match(/^COPY\s+.*--from=(\S+)/);

    if (from) {
      stage = { from: from[1], args: [], copiesFrom: [] };
      stages[from[2] ?? `stage-${Object.keys(stages).length}`] = stage;
    } else if (arg) {
      (stage ? stage.args : globalArgs).push(arg[1]);
    } else if (copyFrom && stage) {
      stage.copiesFrom.push(copyFrom[1]);
    }
  }

  return { content, globalArgs, stages };
}

/**
 * The build args a stage reads: the global ones (used in `FROM`), its own,
 * and those of the stages it builds on or copies from. Docker drops the
 * others.
 */
function argsReadBy(dockerfile: string, target: string): string[] {
  const { globalArgs, stages } = parseDockerfile(dockerfile);
  const args = new Set(globalArgs);
  const pending = [target];

  while (pending.length > 0) {
    const stage = stages[pending.pop()!];

    if (stage) {
      stage.args.forEach((arg) => args.add(arg));
      pending.push(stage.from, ...stage.copiesFrom);
    }
  }

  return [...args];
}

const imageOptions = {
  sitePath: '.',
  absSitePath: '/app',
  packagePath: '/package',
  servicesPath: '/app/.sst/laravel/web',
  deployPath: '/app/.sst/laravel/deploy',
};

describe.each([
  ['web', 'Dockerfile.web', buildImage({ ...imageOptions, role: 'web' })],
  ['worker', 'Dockerfile.worker', buildImage({ ...imageOptions, role: 'worker', confPath: '/app/.sst/laravel/conf' })],
] as const)('the %s image', (_, dockerfile, image) => {
  it(`builds a stage ${dockerfile} has`, () => {
    expect(Object.keys(parseDockerfile(dockerfile).stages)).toContain(image.target);
  });

  it(`only passes build args ${dockerfile} reads`, () => {
    expect(argsReadBy(dockerfile, image.target)).toEqual(expect.arrayContaining(Object.keys(image.args)));
  });

  it('copies the app through a context mount without staging .sst in a layer', () => {
    const { content } = parseDockerfile(dockerfile);

    expect(content).toContain('RUN --mount=type=bind,target=/app-source');
    expect(content).toContain('! -name .sst -exec cp -a -t /var/www/html -- {} +');
    expect(content).not.toContain('--exclude');
    expect(content).not.toMatch(/^COPY [^\n]* \. \/var\/www\/html$/m);
  });

  it('passes PHP_OPCACHE_ENABLE on to the container', () => {
    expect(parseDockerfile(dockerfile).content).toContain('ENV PHP_OPCACHE_ENABLE=${PHP_OPCACHE_ENABLE}');
  });
});
