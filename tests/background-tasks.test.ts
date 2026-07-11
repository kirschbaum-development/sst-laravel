import { describe, expect, it } from 'vitest';
import { buildBackgroundTasks } from '../src/background-tasks';

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
