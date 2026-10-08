import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The `ARG` names declared in each build stage, keyed by stage name.
 * Docker drops a build arg the target stage doesn't declare.
 */
function stageArgs(dockerfile: string): Record<string, string[]> {
  const content = fs.readFileSync(path.resolve(__dirname, '..', dockerfile), 'utf-8');
  const stages: Record<string, string[]> = {};
  let stage = '';

  for (const line of content.split('\n')) {
    const from = line.match(/^FROM\s+\S+\s+AS\s+(\S+)/i);
    const arg = line.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/);

    if (from) {
      stage = from[1];
      stages[stage] = [];
    } else if (arg && stage) {
      stages[stage].push(arg[1]);
    }
  }

  return stages;
}

// The build args the component passes to each image (`getDefaultImage` and
// the web and worker services in laravel-sst.ts). The image builds the `deploy` stage.
describe.each([
  ['Dockerfile.web', ['PHP_OPCACHE_ENABLE', 'CUSTOM_CONF_PATH']],
  ['Dockerfile.worker', ['PHP_OPCACHE_ENABLE']],
])('%s', (dockerfile, deployArgs) => {
  it('has the deploy stage the component builds', () => {
    expect(Object.keys(stageArgs(dockerfile))).toContain('deploy');
  });

  it('declares the build args the component passes', () => {
    expect(stageArgs(dockerfile).deploy).toEqual(expect.arrayContaining(deployArgs));
  });

  it('passes PHP_OPCACHE_ENABLE on to the container', () => {
    const content = fs.readFileSync(path.resolve(__dirname, '..', dockerfile), 'utf-8');

    expect(content).toContain('ENV PHP_OPCACHE_ENABLE=${PHP_OPCACHE_ENABLE}');
  });
});

describe('Dockerfile.worker', () => {
  it('declares the conf paths in the stages that copy them', () => {
    const stages = stageArgs('Dockerfile.worker');

    expect(stages['s6-build']).toContain('CONF_PATH');
    expect(stages.base).toEqual(expect.arrayContaining(['CONF_PATH', 'CUSTOM_CONF_PATH']));
  });
});
