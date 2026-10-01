import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectLaravelBoostVersion,
  installSkillFromPackage,
  isVersionAtLeast,
  resolveSkillTarget,
} from '../bin/utils/skill';

function makeApp(options: {
  installed: unknown;
  boostJson?: object;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-skill-'));
  fs.mkdirSync(path.join(dir, 'vendor', 'composer'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'vendor', 'composer', 'installed.json'),
    JSON.stringify(options.installed),
  );

  if (options.boostJson) {
    fs.writeFileSync(path.join(dir, 'boost.json'), JSON.stringify(options.boostJson));
  }

  return dir;
}

const setUp = { agents: ['claude_code'], skills: [] };

const withBoost = (version: string) => ({
  packages: [
    { name: 'laravel/framework', version: 'v12.0.0' },
    { name: 'laravel/boost', version },
  ],
});

describe('isVersionAtLeast', () => {
  it('compares dotted versions', () => {
    expect(isVersionAtLeast('2.0.0', '2.0.0')).toBe(true);
    expect(isVersionAtLeast('2.1', '2.0.0')).toBe(true);
    expect(isVersionAtLeast('1.9.9', '2.0.0')).toBe(false);
  });
});

describe('detectLaravelBoostVersion', () => {
  it('reads the version from Composer 2 metadata', () => {
    expect(detectLaravelBoostVersion(makeApp({ installed: withBoost('v2.3.1') }))).toBe('2.3.1');
  });

  it('reads the version from Composer 1 metadata', () => {
    const app = makeApp({ installed: [{ name: 'laravel/boost', version: '2.0.0' }] });

    expect(detectLaravelBoostVersion(app)).toBe('2.0.0');
  });

  it('returns null when Boost is not installed', () => {
    const app = makeApp({ installed: { packages: [{ name: 'laravel/framework', version: 'v12.0.0' }] } });

    expect(detectLaravelBoostVersion(app)).toBeNull();
  });
});

describe('resolveSkillTarget', () => {
  it('uses Boost when 2.0+ is installed and set up', () => {
    const app = makeApp({ installed: withBoost('v2.3.1'), boostJson: setUp });

    expect(resolveSkillTarget(app)).toEqual({ type: 'boost', version: '2.3.1' });
  });

  it('falls back to the package copy when Boost is not set up', () => {
    const target = resolveSkillTarget(makeApp({ installed: withBoost('v2.3.1') }));

    expect(target.type).toBe('package');
    expect(target.type === 'package' && target.reason).toContain('boost:install');
  });

  it('falls back to the package copy when boost.json lists no agents', () => {
    const app = makeApp({ installed: withBoost('v2.3.1'), boostJson: { skills: [] } });

    expect(resolveSkillTarget(app).type).toBe('package');
  });

  it('falls back to the package copy for Boost before 2.0', () => {
    const target = resolveSkillTarget(makeApp({ installed: withBoost('v1.8.0'), boostJson: setUp }));

    expect(target.type).toBe('package');
    expect(target.type === 'package' && target.reason).toContain('1.8.0');
  });

  it('uses the package copy when Boost is not installed', () => {
    const app = makeApp({ installed: { packages: [] } });

    expect(resolveSkillTarget(app)).toEqual({ type: 'package' });
  });
});

describe('installSkillFromPackage', () => {
  it('copies the skill to .agents/skills and to the agent folders that exist', () => {
    const app = makeApp({ installed: { packages: [] } });
    fs.mkdirSync(path.join(app, '.claude'));

    const targets = installSkillFromPackage(app);

    expect(targets).toEqual([
      path.join('.agents', 'skills', 'sst-laravel'),
      path.join('.claude', 'skills', 'sst-laravel'),
    ]);
    expect(fs.existsSync(path.join(app, '.agents', 'skills', 'sst-laravel', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(app, '.claude', 'skills', 'sst-laravel', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(app, '.cursor'))).toBe(false);
  });
});
