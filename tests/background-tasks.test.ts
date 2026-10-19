import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeS6ServiceName,
  assertSafeWorkerName,
  assertTaskDependencies,
  buildBackgroundTasks,
  finishScript,
  SCHEDULER_COMMAND,
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
      'laravel-scheduler': { command: SCHEDULER_COMMAND },
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

  it('stops the container when Horizon or the scheduler exits, when asked to', () => {
    expect(
      buildBackgroundTasks(
        { horizon: true, scheduler: true, tasks: { pulse: { command: 'php artisan pulse:work' } } },
        { stopContainerOnExit: true },
      ),
    ).toEqual({
      pulse: { command: 'php artisan pulse:work' },
      'laravel-horizon': { command: 'php artisan horizon', stopContainerOnExit: true },
      'laravel-scheduler': { command: SCHEDULER_COMMAND, stopContainerOnExit: true },
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

  it.each(['user', 'user2', 'base', 'top', 'fix-attrs', 'legacy-cont-init', 'legacy-services', 'nginx', 'php-fpm', 's6rc-oneshot-runner'])(
    'throws on reserved names: %s',
    (name) => {
      expect(() => assertSafeS6ServiceName(name)).toThrow();
    },
  );
});

describe('assertTaskDependencies', () => {
  const builtIn = ['base', 'nginx', 'php-fpm'];

  it('accepts other tasks of the container and built-in services', () => {
    expect(() =>
      assertTaskDependencies(
        'web',
        {
          'laravel-horizon': { command: 'php artisan horizon' },
          pulse: { command: 'php artisan pulse:work', dependencies: ['laravel-horizon', 'php-fpm', 'base'] },
        },
        builtIn,
      ),
    ).not.toThrow();
  });

  it('rejects a dependency on a service the container does not have', () => {
    expect(() =>
      assertTaskDependencies('workers[queue]', { pulse: { command: 'x', dependencies: ['redis'] } }, ['base']),
    ).toThrow('workers[queue].tasks.pulse depends on "redis", which is not another task of workers[queue]. Tasks can depend on the other tasks of the same container, or on: base.');
  });

  it('rejects a task that depends on itself', () => {
    expect(() => assertTaskDependencies('web', { pulse: { command: 'x', dependencies: ['pulse'] } }, builtIn)).toThrow(
      'depends on "pulse"',
    );
  });
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

  const files = () =>
    (fs.readdirSync(buildPath, { recursive: true }) as string[])
      .filter((file) => fs.statSync(path.join(buildPath, file)).isFile())
      .sort();

  it('always creates the user bundle contents.d tree, even with no tasks', () => {
    writeS6TaskFiles({}, buildPath);

    expect(
      fs.existsSync(
        path.join(buildPath, 'etc/s6-overlay/user-bundles.d/user/contents.d'),
      ),
    ).toBe(true);
    expect(files()).toEqual([]);
  });

  it('registers the tasks in user-bundles.d and never defines the user bundle in s6-rc.d', () => {
    writeS6TaskFiles(
      {
        'laravel-horizon': { command: 'php artisan horizon', stopContainerOnExit: true },
        pulse: { command: 'php artisan pulse:work', dependencies: ['laravel-horizon'] },
      },
      buildPath,
    );

    expect(files()).toEqual([
      'etc/s6-overlay/s6-rc.d/laravel-horizon/dependencies.d/base',
      'etc/s6-overlay/s6-rc.d/laravel-horizon/finish',
      'etc/s6-overlay/s6-rc.d/laravel-horizon/run',
      'etc/s6-overlay/s6-rc.d/laravel-horizon/script',
      'etc/s6-overlay/s6-rc.d/laravel-horizon/type',
      'etc/s6-overlay/s6-rc.d/pulse/dependencies.d/base',
      'etc/s6-overlay/s6-rc.d/pulse/dependencies.d/laravel-horizon',
      'etc/s6-overlay/s6-rc.d/pulse/finish',
      'etc/s6-overlay/s6-rc.d/pulse/run',
      'etc/s6-overlay/s6-rc.d/pulse/script',
      'etc/s6-overlay/s6-rc.d/pulse/type',
      'etc/s6-overlay/user-bundles.d/user/contents.d/laravel-horizon',
      'etc/s6-overlay/user-bundles.d/user/contents.d/pulse',
    ]);
    expect(fs.existsSync(path.join(buildPath, 'etc/s6-overlay/s6-rc.d/user'))).toBe(false);
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
    expect(fs.readdirSync(path.join(taskDir, 'dependencies.d'))).toEqual(['base']);
    // s6 restarts it: the finish script only logs the exit.
    expect(fs.readFileSync(path.join(taskDir, 'finish'), 'utf-8')).not.toContain('halt');
    expect(
      fs.existsSync(
        path.join(
          buildPath,
          'etc/s6-overlay/user-bundles.d/user/contents.d/laravel-horizon',
        ),
      ),
    ).toBe(true);
  });

  it('writes the base bundle and each task dependency into dependencies.d', () => {
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
      fs.readdirSync(path.join(buildPath, 'etc/s6-overlay/s6-rc.d/queue/dependencies.d')).sort(),
    ).toEqual(['a', 'b', 'base']);
  });

  it('writes a finish script that stops the container unless s6 stopped the process', () => {
    writeS6TaskFiles(
      { 'laravel-horizon': { command: 'php artisan horizon', stopContainerOnExit: true } },
      buildPath,
    );

    const finish = path.join(buildPath, 'etc/s6-overlay/s6-rc.d/laravel-horizon/finish');

    expect(fs.readFileSync(finish, 'utf-8')).toBe(
      [
        '#!/bin/sh',
        '# s6 passes the exit code, or 256 and the signal when a signal killed the process.',
        'if [ "$(/command/s6-svstat -o wantedup .)" = "false" ]; then',
        '  exit 0',
        'fi',
        '',
        'code="$1"',
        'if [ "$code" -eq 256 ]; then',
        '  code=$((128 + $2))',
        'fi',
        '',
        `echo '{"sst_laravel":"process_exit","process":"laravel-horizon","exit_code":'"$code"',"action":"stop_container","message":"laravel-horizon exited with code '"$code"'. Stopping the container."}' >&2`,
        'echo "$code" > /run/s6-linux-init-container-results/exitcode',
        'exec /run/s6/basedir/bin/halt',
        '',
      ].join('\n'),
    );
    expect(fs.statSync(finish).mode & 0o100).toBeTruthy();
  });

  it('logs each exit as one JSON line the CLI can read', () => {
    const line = finishScript('pulse', false).split('\n').find((candidate) => candidate.startsWith('echo '))!;
    const output = execFileSync('sh', ['-c', `{ code=137; ${line}; } 2>&1`], { encoding: 'utf-8' });

    expect(JSON.parse(output)).toEqual({
      sst_laravel: 'process_exit',
      process: 'pulse',
      exit_code: 137,
      action: 'restart',
      message: 'pulse exited with code 137. Restarting it.',
    });
  });

  it('rejects dependencies that are not a single safe name', () => {
    expect(() =>
      writeS6TaskFiles({ queue: { command: 'x', dependencies: ['../../escape'] } }, buildPath),
    ).toThrow('Invalid dependency "../../escape" of background task "queue".');
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
      { 'laravel-scheduler': { command: SCHEDULER_COMMAND } },
      buildPath,
    );

    const s6RcDPath = path.join(buildPath, 'etc/s6-overlay/s6-rc.d');
    const contentsPath = path.join(buildPath, 'etc/s6-overlay/user-bundles.d/user/contents.d');

    expect(fs.existsSync(path.join(s6RcDPath, 'laravel-horizon'))).toBe(false);
    expect(fs.existsSync(path.join(contentsPath, 'laravel-horizon'))).toBe(false);
    expect(fs.existsSync(path.join(s6RcDPath, 'laravel-scheduler'))).toBe(true);
    expect(fs.existsSync(path.join(contentsPath, 'laravel-scheduler'))).toBe(true);
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
