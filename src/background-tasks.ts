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
