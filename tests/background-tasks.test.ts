import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeS6ServiceName,
  assertSafeWorkerName,
  buildBackgroundTasks,
  writeS6TaskFiles,
} from '../src/background-tasks';

describe('buildBackgroundTasks', () => {
  it('returns an empty map when nothing is configured', () => {
    expect(buildBackgroundTasks({})).toEqual({});
  });

  it('adds the horizon task when horizon is enabled', () => {
    expect(buildBackgroundTasks({ horizon: true })).toEqual({
      'laravel-horizon': { command: 'php artisan horizon' },
    });
  });

  it('adds the scheduler task when scheduler is enabled', () => {
    expect(buildBackgroundTasks({ scheduler: true })).toEqual({
      'laravel-scheduler': { command: 'php artisan schedule:work' },
    });
  });

  it('merges custom tasks with the default tasks', () => {
    expect(
      buildBackgroundTasks({
        horizon: true,
        tasks: { pulse: { command: 'php artisan pulse:work' } },
      }),
    ).toEqual({
      pulse: { command: 'php artisan pulse:work' },
      'laravel-horizon': { command: 'php artisan horizon' },
    });
  });

  it('lets the horizon default win over a same-named custom task', () => {
    expect(
      buildBackgroundTasks({
        horizon: true,
        tasks: { 'laravel-horizon': { command: 'custom' } },
      }),
    ).toEqual({
      'laravel-horizon': { command: 'php artisan horizon' },
    });
  });

  it('ignores disabled flags', () => {
    expect(buildBackgroundTasks({ horizon: false, scheduler: false })).toEqual(
      {},
    );
  });
});

describe('assertSafeS6ServiceName', () => {
  it.each(['pulse', 'laravel-horizon', 'my_task.v2', 'worker-1'])(
    'accepts typical names: %s',
    (name) => {
      expect(() => assertSafeS6ServiceName(name)).not.toThrow();
    },
  );

  it.each(['foo/bar', '..', '../escape', 'foo/../../bar', '/etc'])(
    'throws on names with path separators: %s',
    (name) => {
      expect(() => assertSafeS6ServiceName(name)).toThrow();
    },
  );

  it('throws on names starting with "."', () => {
    expect(() => assertSafeS6ServiceName('.hidden')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => assertSafeS6ServiceName('')).toThrow();
  });

  it.each(['user', 'nginx', 'php-fpm'])(
    'throws on reserved names: %s',
    (name) => {
      expect(() => assertSafeS6ServiceName(name)).toThrow();
    },
  );
});

describe('assertSafeWorkerName', () => {
  it.each(['nginx', 'foo..bar', 'my worker', 'worker-1'])(
    'accepts single-segment names: %s',
    (name) => {
      expect(() => assertSafeWorkerName(name)).not.toThrow();
    },
  );

  it.each(['a/b', 'a\\b', '..', '.'])(
    'throws on non-segment names: %s',
    (name) => {
      expect(() => assertSafeWorkerName(name)).toThrow();
    },
  );

  it('throws on empty string', () => {
    expect(() => assertSafeWorkerName('')).toThrow();
  });
});

describe('writeS6TaskFiles', () => {
  let buildPath: string;

  beforeEach(() => {
    buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-s6-'));
  });

  afterEach(() => {
    fs.rmSync(buildPath, { recursive: true, force: true });
  });

  it('always creates the s6 user contents.d tree, even with no tasks', () => {
    writeS6TaskFiles({}, buildPath);

    expect(
      fs.existsSync(
        path.join(buildPath, 'etc/s6-overlay/s6-rc.d/user/contents.d'),
      ),
    ).toBe(true);
  });

  it('writes the s6 service files for each task', () => {
    writeS6TaskFiles(
      { 'laravel-horizon': { command: 'php artisan horizon' } },
      buildPath,
    );

    const taskDir = path.join(
      buildPath,
      'etc/s6-overlay/s6-rc.d/laravel-horizon',
    );

    expect(fs.readFileSync(path.join(taskDir, 'script'), 'utf-8')).toBe(
      '#!/command/with-contenv bash\ncd /var/www/html\nphp artisan horizon',
    );
    expect(fs.readFileSync(path.join(taskDir, 'run'), 'utf-8')).toBe(
      '#!/command/execlineb -P\n/etc/s6-overlay/s6-rc.d/laravel-horizon/script',
    );
    expect(fs.readFileSync(path.join(taskDir, 'type'), 'utf-8')).toBe(
      'longrun',
    );
    expect(fs.readFileSync(path.join(taskDir, 'dependencies'), 'utf-8')).toBe(
      '',
    );
    expect(
      fs.existsSync(
        path.join(
          buildPath,
          'etc/s6-overlay/s6-rc.d/user/contents.d/laravel-horizon',
        ),
      ),
    ).toBe(true);
  });

  it('writes task dependencies one per line', () => {
    writeS6TaskFiles(
      {
        queue: {
          command: 'php artisan queue:work',
          dependencies: ['a', 'b'],
        },
      },
      buildPath,
    );

    expect(
      fs.readFileSync(
        path.join(buildPath, 'etc/s6-overlay/s6-rc.d/queue/dependencies'),
        'utf-8',
      ),
    ).toBe('a\nb');
  });

  it('makes script and run executable by the owner', () => {
    writeS6TaskFiles(
      { 'laravel-horizon': { command: 'php artisan horizon' } },
      buildPath,
    );

    const taskDir = path.join(
      buildPath,
      'etc/s6-overlay/s6-rc.d/laravel-horizon',
    );

    expect(fs.statSync(path.join(taskDir, 'script')).mode & 0o100).toBeTruthy();
    expect(fs.statSync(path.join(taskDir, 'run')).mode & 0o100).toBeTruthy();
  });

  it('removes stale tasks from a previous run', () => {
    writeS6TaskFiles(
      { 'laravel-horizon': { command: 'php artisan horizon' } },
      buildPath,
    );
    writeS6TaskFiles(
      { 'laravel-scheduler': { command: 'php artisan schedule:work' } },
      buildPath,
    );

    const s6RcDPath = path.join(buildPath, 'etc/s6-overlay/s6-rc.d');

    expect(fs.existsSync(path.join(s6RcDPath, 'laravel-horizon'))).toBe(false);
    expect(
      fs.existsSync(path.join(s6RcDPath, 'user/contents.d/laravel-horizon')),
    ).toBe(false);
    expect(fs.existsSync(path.join(s6RcDPath, 'laravel-scheduler'))).toBe(true);
    expect(
      fs.existsSync(path.join(s6RcDPath, 'user/contents.d/laravel-scheduler')),
    ).toBe(true);
  });

  it('rejects unsafe task names before deleting anything', () => {
    writeS6TaskFiles({ keep: { command: 'echo ok' } }, buildPath);

    expect(() =>
      writeS6TaskFiles({ '../escape': { command: 'x' } }, buildPath),
    ).toThrow();

    expect(
      fs.existsSync(
        path.join(buildPath, 'etc/s6-overlay/s6-rc.d/keep'),
      ),
    ).toBe(true);
  });

  it('rejects reserved task names', () => {
    expect(() =>
      writeS6TaskFiles({ nginx: { command: 'x' } }, buildPath),
    ).toThrow(/reserved/);
  });
});
