import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stageWorkerConf } from '../src/worker-conf';

const packageRoot = path.resolve(__dirname, '..');

describe('stageWorkerConf', () => {
  it('copies the package conf folder into the build directory', () => {
    const buildPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-conf-')), 'conf');

    stageWorkerConf(packageRoot, buildPath);

    expect(fs.existsSync(path.join(buildPath, 'usr/local/bin/s6-install.sh'))).toBe(true);
    expect(fs.existsSync(path.join(buildPath, 'usr/local/bin/entrypoint.sh'))).toBe(true);
    expect(fs.existsSync(path.join(buildPath, 'etc/s6-overlay/s6-rc.d/laravel-horizon/finish'))).toBe(true);
  });

  it('removes files left over from an earlier deploy', () => {
    const buildPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-conf-')), 'conf');
    fs.mkdirSync(buildPath, { recursive: true });
    fs.writeFileSync(path.join(buildPath, 'stale'), '');

    stageWorkerConf(packageRoot, buildPath);

    expect(fs.existsSync(path.join(buildPath, 'stale'))).toBe(false);
  });
});
