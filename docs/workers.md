# Workers

Beyond HTTP requests, you can set up one or more `workers` for your Laravel application. Workers are meant to run background commands like Laravel Horizon, the Laravel Scheduler, or any background command you may need to run.

SST Laravel automatically deploys and configures worker containers running your configured commands. Check all the `workers` options in the [API reference](api.md#workers).

## Running the Laravel scheduler

```js
const app = new LaravelService('MyLaravelApp', {
  workers: [
    {
      name: 'scheduler',
      scheduler: true,
    },
  ],
});
```

## Running Laravel Horizon

```js
const app = new LaravelService('MyLaravelApp', {
  workers: [
    {
      name: 'horizon',
      horizon: true,
    },
  ],
});
```

## Running custom commands

```js
const app = new LaravelService('MyLaravelApp', {
  workers: [
    {
      name: 'worker',
      tasks: {
        'scheduler': {
          command: 'php artisan schedule:work',
        },
        'queue': {
          command: 'php artisan queue:work',
        },
        'pulse': {
          command: 'php artisan pulse:work',
        },
      },
    },
  ],
});
```

Each task runs as `www-data` under [s6-overlay](https://github.com/just-containers/s6-overlay), which restarts it in place when it exits. Task names can use letters, numbers, `.`, `_`, and `-`. Names that s6-overlay or the images already use (`user`, `user2`, `base`, `top`, `fix-attrs`, `legacy-cont-init`, `legacy-services`, `nginx`, `php-fpm`, or anything starting with `s6rc-`) are rejected.

To start a task only after another one, list it in `dependencies`. A task can depend on the other tasks of the same container, and in the web container also on `nginx` and `php-fpm`. The deploy fails before building anything when a dependency names a service the container doesn't have:

```js
tasks: {
  'pulse': {
    command: 'php artisan pulse:work',
    dependencies: ['queue'],
  },
},
```

## When a process exits

- In workers, when Horizon or the scheduler exits, the container stops with the process's exit code, so ECS replaces the task. A deploy whose new Horizon or scheduler keeps exiting therefore fails and is rolled back, instead of looking healthy while the process restarts over and over.
- Custom `tasks`, Reverb, and every process in the web container are restarted in place by s6, so a crash never interrupts HTTP traffic.

## Background processes in the web container

For smaller applications, you can run Horizon, the scheduler, or any custom long-running command inside the web container instead of paying for a dedicated worker service. The `web` block accepts the same `horizon`, `scheduler`, and `tasks` options as `workers[]`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
    horizon: true,
    scheduler: true,
    tasks: {
      pulse: {
        command: 'php artisan pulse:work',
      },
    },
  },
});
```

A few things to keep in mind:

- Background processes share the web container's CPU and memory with nginx and PHP-FPM. If they need dedicated resources, use a `workers` entry instead.
- In the web container, s6 restarts a process that exits in place, so a crash never interrupts HTTP traffic. See [When a process exits](#when-a-process-exits).
- If the web service scales beyond one container, every replica runs these processes. Horizon handles this fine (shared queue), but scheduled jobs should use `onOneServer()` backed by a shared cache store to avoid running more than once.
