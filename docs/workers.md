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
- In workers, a dead Horizon or scheduler process halts the container, so ECS replaces it. In the web container, s6 restarts the process in place, so a crash never interrupts HTTP traffic.
- If the web service scales beyond one container, every replica runs these processes. Horizon handles this fine (shared queue), but scheduled jobs should use `onOneServer()` backed by a shared cache store to avoid running more than once.
