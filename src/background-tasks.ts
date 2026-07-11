import * as fs from 'fs';
import * as path from 'path';

/**
 * A single supervised background process, matching the shape of the `tasks`
 * entries on the `web` and `workers[]` config blocks.
 */
export interface BackgroundTask {
  command: string;
  dependencies?: string[];
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

const RESERVED_TASK_NAMES = ['user', 'nginx', 'php-fpm'];

const SAFE_TASK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Ensures a task or worker name is a single safe path segment, so generated
 * s6 files stay inside the build directory and cannot collide with the stock
 * s6 services shipped in the base images.
 */
export function assertSafeS6ServiceName(name: string): void {
  if (!SAFE_TASK_NAME.test(name) || name.includes('..')) {
    throw new Error(
      `Invalid background task name "${name}": names must contain only letters, numbers, ".", "_" or "-", and must not start with "." or contain path separators.`,
    );
  }

  if (RESERVED_TASK_NAMES.includes(name)) {
    throw new Error(
      `Invalid background task name "${name}": this name is reserved by the s6 services built into the container image.`,
    );
  }
}

/**
 * Merges the custom `tasks` map with the `horizon`/`scheduler` defaults. The
 * defaults win over same-named custom tasks.
 */
export function buildBackgroundTasks(
  config: BackgroundTasksConfig,
): Record<string, BackgroundTask> {
  const tasks: Record<string, BackgroundTask> = {
    ...((config.tasks as Record<string, BackgroundTask>) ?? {}),
  };

  if (config.horizon) {
    tasks['laravel-horizon'] = { command: 'php artisan horizon' };
  }

  if (config.scheduler) {
    tasks['laravel-scheduler'] = { command: 'php artisan schedule:work' };
  }

  return tasks;
}

/**
 * Writes the s6-overlay service tree for the given tasks into a build
 * directory that is later copied into the Docker image. Always creates the
 * `user/contents.d` tree so the Docker COPY step never fails, even when no
 * tasks are configured. The build directory is wiped before regenerating so
 * tasks removed since the previous run don't linger.
 */
export function writeS6TaskFiles(
  tasks: Record<string, BackgroundTask>,
  buildPath: string,
): void {
  Object.keys(tasks).forEach(assertSafeS6ServiceName);

  fs.rmSync(buildPath, { recursive: true, force: true });

  const s6RcDPath = path.resolve(buildPath, 'etc/s6-overlay/s6-rc.d');
  const s6UserContentsPath = path.resolve(s6RcDPath, 'user/contents.d');

  fs.mkdirSync(s6UserContentsPath, { recursive: true });

  Object.entries(tasks).forEach(([taskName, config]) => {
    const tasksDir = path.resolve(s6RcDPath, taskName);
    fs.mkdirSync(tasksDir, { recursive: true });

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
    fs.writeFileSync(
      path.join(tasksDir, 'dependencies'),
      (config.dependencies || []).join('\n'),
    );
    fs.writeFileSync(path.join(s6UserContentsPath, taskName), '');
  });
}
