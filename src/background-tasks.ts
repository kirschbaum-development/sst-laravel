import * as fs from 'fs';
import * as path from 'path';

/**
 * A single supervised background process, matching the shape of the `tasks`
 * entries on the `web` and `workers[]` config blocks.
 */
export interface BackgroundTask {
  command: string;
  dependencies?: string[];
  /**
   * Stop the container when the process exits, so ECS replaces it, instead
   * of s6 restarting the process in place. Set on the Horizon and scheduler
   * of workers.
   */
  stopContainerOnExit?: boolean;
}

/**
 * The task-bearing subset of a `web` or `workers[]` config block. Fields are
 * typed loosely because the component declares them as Pulumi `Input`s but
 * consumes them synchronously as plain values.
 */
export interface BackgroundTasksConfig {
  horizon?: unknown;
  scheduler?: unknown;
  tasks?: unknown;
}

/**
 * The s6 services a task can depend on besides the other tasks of its
 * container: s6-overlay's `base` bundle, and nginx and php-fpm on web.
 */
export const BUILT_IN_S6_SERVICES = {
  web: ['base', 'nginx', 'php-fpm'],
  worker: ['base'],
};

/**
 * Names s6-overlay and the ServerSideUp images already define. A task with
 * one of them fails to compile when the container starts.
 */
const RESERVED_TASK_NAMES = [
  'user',
  'user2',
  'base',
  'top',
  'fix-attrs',
  'legacy-cont-init',
  'legacy-services',
  'nginx',
  'php-fpm',
];

const SAFE_TASK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const isSafeS6Name = (name: string) => SAFE_TASK_NAME.test(name) && !name.includes('..');

/**
 * Ensures a task name is a single safe path segment, so generated s6 files
 * stay inside the build directory and cannot collide with the stock s6
 * services shipped in the base images.
 */
export function assertSafeS6ServiceName(name: string): void {
  if (!isSafeS6Name(name)) {
    throw new Error(
      `Invalid background task name "${name}": names must contain only letters, numbers, ".", "_" or "-", and must not start with "." or contain path separators.`,
    );
  }

  if (RESERVED_TASK_NAMES.includes(name) || name.startsWith('s6rc-')) {
    throw new Error(
      `Invalid background task name "${name}": this name is reserved by the s6 services built into the container image.`,
    );
  }
}

/**
 * Ensures every dependency of the tasks names another task of the same
 * container or one of the `builtIn` services. s6 refuses to start a
 * container whose services depend on one that doesn't exist.
 */
export function assertTaskDependencies(
  label: string,
  tasks: Record<string, BackgroundTask>,
  builtIn: string[],
): void {
  for (const [taskName, task] of Object.entries(tasks)) {
    for (const dependency of task.dependencies ?? []) {
      if (dependency === taskName || (!(dependency in tasks) && !builtIn.includes(dependency))) {
        throw new Error(
          `${label}.tasks.${taskName} depends on "${dependency}", which is not another task of ${label}. Tasks can depend on the other tasks of the same container, or on: ${builtIn.join(', ')}.`,
        );
      }
    }
  }
}

/**
 * Ensures a worker name is a single safe path segment. Worker names only
 * shape the `worker-<name>` build directory, so unlike task names they may
 * use any characters except path separators.
 */
export function assertSafeWorkerName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error(
      `Invalid worker name "${name}": names must be a single path segment without "/" or "\\".`,
    );
  }
}

/**
 * Merges the custom `tasks` map with the `horizon`/`scheduler` defaults. The
 * defaults win over same-named custom tasks. With `stopContainerOnExit`
 * (workers), the container stops when Horizon or the scheduler exits.
 */
export function buildBackgroundTasks(
  config: BackgroundTasksConfig,
  options: { stopContainerOnExit?: boolean } = {},
): Record<string, BackgroundTask> {
  const tasks: Record<string, BackgroundTask> = {
    ...((config.tasks as Record<string, BackgroundTask>) ?? {}),
  };
  const stop = options.stopContainerOnExit ? { stopContainerOnExit: true } : {};

  if (config.horizon) {
    tasks['laravel-horizon'] = { command: 'php artisan horizon', ...stop };
  }

  if (config.scheduler) {
    tasks['laravel-scheduler'] = { command: 'php artisan schedule:work', ...stop };
  }

  return tasks;
}

/**
 * The `finish` script of a task that stops the container. s6 runs it when
 * the process exits. When s6 stopped the process (the container is shutting
 * down), it does nothing; otherwise it stops the container with the
 * process's exit code.
 */
function stopContainerScript(taskName: string): string {
  return [
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
    `echo "${taskName} exited with code $code. Stopping the container." >&2`,
    'echo "$code" > /run/s6-linux-init-container-results/exitcode',
    'exec /run/s6/basedir/bin/halt',
    '',
  ].join('\n');
}

/**
 * Writes the s6-overlay services of the given tasks into a build directory
 * that is later copied over the image root:
 *
 * - `etc/s6-overlay/s6-rc.d/<task>`: the longrun, depending on s6-overlay's
 *   `base` bundle and the task's `dependencies`.
 * - `etc/s6-overlay/user-bundles.d/user/contents.d/<task>`: adds it to the
 *   `user` bundle, which s6-overlay starts.
 *
 * The bundle must stay out of `s6-rc.d`: s6-overlay 3.2.3.2 (ServerSideUp
 * v5) ignores `user-bundles.d` when `s6-rc.d/user` exists, so nginx and
 * php-fpm never start, and it writes to `/etc` at boot, which fails as
 * www-data.
 *
 * Always creates the `contents.d` folder, so the Docker COPY step never
 * fails, even when no tasks are configured. The build directory is wiped
 * before regenerating so tasks removed since the previous run don't linger.
 */
export function writeS6TaskFiles(
  tasks: Record<string, BackgroundTask>,
  buildPath: string,
): void {
  for (const [taskName, task] of Object.entries(tasks)) {
    assertSafeS6ServiceName(taskName);

    for (const dependency of task.dependencies ?? []) {
      if (!isSafeS6Name(dependency)) {
        throw new Error(`Invalid dependency "${dependency}" of background task "${taskName}".`);
      }
    }
  }

  fs.rmSync(buildPath, { recursive: true, force: true });

  const s6RcDPath = path.resolve(buildPath, 'etc/s6-overlay/s6-rc.d');
  const s6UserContentsPath = path.resolve(buildPath, 'etc/s6-overlay/user-bundles.d/user/contents.d');

  fs.mkdirSync(s6UserContentsPath, { recursive: true });

  Object.entries(tasks).forEach(([taskName, config]) => {
    const tasksDir = path.resolve(s6RcDPath, taskName);
    const dependenciesDir = path.join(tasksDir, 'dependencies.d');
    fs.mkdirSync(dependenciesDir, { recursive: true });

    fs.writeFileSync(
      path.join(tasksDir, 'script'),
      `#!/command/with-contenv bash\ncd /var/www/html\n${config.command}`,
      { mode: 0o777 },
    );
    fs.writeFileSync(
      path.join(tasksDir, 'run'),
      `#!/command/execlineb -P\n/etc/s6-overlay/s6-rc.d/${taskName}/script`,
      { mode: 0o777 },
    );
    fs.writeFileSync(path.join(tasksDir, 'type'), 'longrun');

    for (const dependency of ['base', ...(config.dependencies ?? [])]) {
      fs.writeFileSync(path.join(dependenciesDir, dependency), '');
    }

    if (config.stopContainerOnExit) {
      fs.writeFileSync(path.join(tasksDir, 'finish'), stopContainerScript(taskName), { mode: 0o777 });
    }

    fs.writeFileSync(path.join(s6UserContentsPath, taskName), '');
  });
}
