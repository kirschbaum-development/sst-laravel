import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stageDeploymentScript, stageWorkerConf } from '../src/build-files';

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

describe('stageDeploymentScript', () => {
  const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-deploy-'));

  it('copies the deployment script as an executable', () => {
    const site = tempDir();
    const deployPath = path.join(tempDir(), 'deploy');
    fs.writeFileSync(path.join(site, 'deploy.sh'), '#!/bin/sh\nphp artisan migrate --force\n');

    stageDeploymentScript(site, 'deploy.sh', deployPath);

    const staged = path.join(deployPath, '60-deploy.sh');
    expect(fs.readFileSync(staged, 'utf-8')).toContain('migrate');
    expect(fs.statSync(staged).mode & 0o777).toBe(0o755);
  });

  it('writes a script that does nothing without one', () => {
    const deployPath = path.join(tempDir(), 'deploy');

    stageDeploymentScript(tempDir(), undefined, deployPath);

    expect(fs.readFileSync(path.join(deployPath, '60-deploy.sh'), 'utf-8')).toBe('#!/bin/sh\nexit 0\n');
  });
});
