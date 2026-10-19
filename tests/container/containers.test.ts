/**
 * Builds the images with the real Dockerfiles and the files the component
 * generates, starts them, and checks that they serve HTTP and run their
 * background processes as www-data. Run with `npm run test:containers`.
 *
 * Needs Docker, or Podman (`CONTAINER_RUNTIME=podman`). `PHP_VERSION` picks
 * the ServerSideUp images (default 8.5). The images are kept, tagged
 * `localhost/sst-laravel-test-<app>-<kind>:php<version>`, so the next run is fast.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { output } from '@pulumi/pulumi';
import type { LaravelArgs } from '../../laravel-sst';
import { writeS6TaskFiles } from '../../src/background-tasks';
import { stageDeploymentScript, stageEnvironmentScript, stageWorkerConf } from '../../src/build-files';
import { loadEnvFile } from '../../src/dotenv';
import { buildImage } from '../../src/image';
import { planServices, resolveReverbArgs, ServicePlan } from '../../src/services';

const packageRoot = path.resolve(__dirname, '../..');
const phpVersion = process.env.PHP_VERSION ?? '8.5';
const prefix = `sst-laravel-test-${process.pid}`;

const detectRuntime = (): string => {
  if (process.env.CONTAINER_RUNTIME) {
    return process.env.CONTAINER_RUNTIME;
  }

  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 ? 'docker' : 'podman';
};

const runtime = detectRuntime();

// Podman mounts the systemd notify socket into /run of build containers,
// where the worker's `chown -R /run` can't change it.
const { NOTIFY_SOCKET: _notifySocket, ...runtimeEnv } = process.env;

const run = (args: string[], options: { allowFailure?: boolean } = {}) => {
  const result = spawnSync(runtime, args, { env: runtimeEnv, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${runtime} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await check();

    if (value !== undefined) {
      return value;
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${what}`);
}

interface Process {
  pid: number;
  uid: number;
  command: string;
}

/** Every process of the container, read from /proc so it works without ps. */
const processes = (container: string): Process[] =>
  run([
    'exec',
    container,
    'sh',
    '-c',
    // Processes can exit while the loop reads them.
    'for p in /proc/[0-9]*; do u=$(awk \'/^Uid:/{print $2}\' $p/status 2>/dev/null); c=$(tr "\\0" " " 2>/dev/null < $p/cmdline); [ -n "$c" ] && echo "${p#/proc/} $u $c"; done; exit 0',
  ])
    .output.trim()
    .split('\n')
    .map((line) => line.match(/^(\d+) (\d+) (.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), uid: Number(match[2]), command: match[3].trim() }));

const findProcess = (container: string, command: string) =>
  processes(container).find((process) => process.command === command);

const WWW_DATA = 33;

/** The scheduler's loop, which starts `php artisan schedule:run` every minute. */
const SCHEDULER = 'bash /etc/s6-overlay/s6-rc.d/laravel-scheduler/script';

const isRunning = (container: string) =>
  run(['inspect', '--format', '{{.State.Running}}', container]).output.trim() === 'true';

const exitCode = (container: string) => Number(run(['inspect', '--format', '{{.State.ExitCode}}', container]).output.trim());

const logs = (container: string) => run(['logs', container]).output;

/**
 * Stops the container with SIGTERM and returns how long it took. The images
 * declare STOPSIGNAL SIGQUIT, but s6-overlay ignores SIGQUIT (its handler is
 * empty), so `stop` would wait for its timeout and SIGKILL the container.
 */
const stopWithSigterm = async (container: string) => {
  const started = Date.now();
  run(['kill', '--signal', 'TERM', container]);
  await waitFor(() => (isRunning(container) ? undefined : true), 30000, `${container} to stop`);
  return Date.now() - started;
};

const hostPort = (container: string, port: number) => {
  const match = run(['port', container, `${port}/tcp`]).output.trim().match(/:(\d+)\s*$/m);

  if (!match) {
    throw new Error(`${container} does not publish port ${port}`);
  }

  return Number(match[1]);
};

const httpGet = async (port: number, urlPath: string) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
};

/** Signals the process, from inside the container, as the user that runs it. */
const kill = (container: string, pid: number, signal = 'TERM') => run(['exec', container, 'kill', `-${signal}`, String(pid)]);

// The app: a stand-in Laravel in tests/container/app, configured with every
// kind of background process.
const appConfig: LaravelArgs = {
  config: {
    php: Number(phpVersion),
    phpExtensions: ['calendar'],
    buildCommands: [
      'test "$(id -u)" = 0 && test ! -e /var/www/html/artisan && test ! -e /var/www/html/.env',
      'apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*',
      `printf '%s\\n' "it's custom" 'literal $HOME' > /usr/local/share/sst-laravel-build-test
printf '%s\\n' 'memory_limit=192M' > /usr/local/etc/php/conf.d/zz-sst-laravel-test.ini`,
      'test -f /usr/local/share/sst-laravel-build-test',
    ],
  },
  web: {
    horizon: true,
    scheduler: true,
    tasks: {
      pulse: { command: 'php artisan pulse:work', dependencies: ['laravel-horizon', 'php-fpm'] },
    },
  },
  workers: [
    {
      name: 'queue',
      horizon: true,
      scheduler: true,
      tasks: { pulse: { command: 'php artisan pulse:work' } },
    },
  ],
  reverb: true,
};

let context: string;
const containers: string[] = [];

async function buildPlanImage(app: string, plan: ServicePlan, deployPath: string, confPath: string, config: LaravelArgs['config']) {
  const image = buildImage({
    role: plan.image,
    sitePath: context,
    absSitePath: context,
    packagePath: packageRoot,
    php: Number(phpVersion),
    phpExtensions: config?.phpExtensions,
    buildCommands: config?.buildCommands,
    servicesPath: plan.buildPath,
    deployPath,
    confPath: plan.image === 'worker' ? confPath : undefined,
  });
  const args = await new Promise<Record<string, string>>((resolve) => output(image.args).apply(resolve));
  // A fixed tag, so the next run builds from the cache of this one.
  const tag = `localhost/sst-laravel-test-${app.toLowerCase()}-${plan.kind}:php${phpVersion}`;

  run([
    'build',
    '--file',
    image.dockerfile,
    '--target',
    image.target,
    ...Object.entries(args).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
    '--tag',
    tag,
    context,
  ]);

  return tag;
}

const startContainer = (image: string, publish?: number, env: Record<string, string> = {}) => {
  const name = `${prefix}-${containers.length}`;
  run([
    'run', '--detach', '--name', name,
    ...(publish ? ['--publish', `127.0.0.1::${publish}`] : []),
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image,
  ]);
  containers.push(name);
  return name;
};

/**
 * Stages a `LaravelService` the way the component does, in
 * `.sst/laravel/<name>`, and builds the image of each service, by label.
 */
async function buildApp(name: string, config: LaravelArgs) {
  const buildPath = path.join(context, '.sst/laravel', name);
  const deployPath = path.join(buildPath, 'deploy');
  const confPath = path.join(buildPath, 'conf');
  const plans = planServices(name, config, { sitePath: context, buildPath, reverb: resolveReverbArgs(config.reverb) });

  fs.mkdirSync(deployPath, { recursive: true });
  fs.writeFileSync(path.join(deployPath, '.env'), 'APP_ENV=production\n');
  stageEnvironmentScript(deployPath);
  stageDeploymentScript(context, undefined, deployPath);
  stageWorkerConf(packageRoot, confPath);

  const images: Record<string, string> = {};

  for (const plan of plans) {
    writeS6TaskFiles(plan.tasks, plan.buildPath);
    images[plan.label] = await buildPlanImage(name, plan, deployPath, confPath, config.config);
  }

  return { plans, images, deployPath };
}

let app: Awaited<ReturnType<typeof buildApp>>;
let plain: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  context = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-containers-'));
  fs.cpSync(path.join(__dirname, 'app'), context, { recursive: true });
  fs.chmodSync(path.join(context, 'artisan'), 0o755);
  fs.mkdirSync(path.join(context, '.sst/other-component'), { recursive: true });
  fs.writeFileSync(path.join(context, '.sst/other-component/secret'), 'must-not-ship');
  fs.writeFileSync(path.join(context, '.app-dotfile'), 'keep-me');

  app = await buildApp('App', appConfig);
  // A web container without background processes.
  plain = await buildApp('Plain', { config: { php: Number(phpVersion) }, web: {} });
}, 30 * 60 * 1000);

afterAll(() => {
  for (const container of containers) {
    run(['rm', '--force', container], { allowFailure: true });
  }

  if (context) {
    fs.rmSync(context, { recursive: true, force: true });
  }
});

const plan = (label: string) => app.plans.find((candidate) => candidate.label === label)!;
const imageFor = (plan: ServicePlan) => app.images[plan.label];

describe('image customization', () => {
  it.each(['web', 'workers[queue]', 'reverb'])('%s keeps extra extensions, software, and configuration at runtime', (label) => {
    const container = startContainer(app.images[label]);
    expect(run(['exec', container, 'php', '-r', 'exit(extension_loaded("calendar") && extension_loaded("gd") && extension_loaded("intl") ? 0 : 1);']).status).toBe(0);
    expect(run(['exec', container, 'jq', '--version']).output).toMatch(/^jq-/);
    expect(run(['exec', container, 'cat', '/usr/local/share/sst-laravel-build-test']).output).toBe("it's custom\nliteral $HOME\n");
    expect(run(['exec', container, 'php', '-r', 'echo ini_get("memory_limit");']).output).toBe('192M');
    expect(run(['exec', container, 'id', '-u']).output.trim()).toBe('33');
  });

  it('does not leak customization into another component', () => {
    const container = startContainer(plain.images.web);
    expect(run(['exec', container, 'test', '!', '-e', '/usr/local/share/sst-laravel-build-test']).status).toBe(0);
  });

  it.each(['web', 'worker'] as const)('fails the %s build when a command fails', async (role) => {
    const image = buildImage({
      role,
      sitePath: context,
      absSitePath: context,
      packagePath: packageRoot,
      php: Number(phpVersion),
      phpExtensions: appConfig.config!.phpExtensions,
      buildCommands: ['exit 42', 'true'],
      servicesPath: plan('web').buildPath,
      deployPath: app.deployPath,
      confPath: role === 'worker' ? path.join(context, '.sst/laravel/App/conf') : undefined,
    });
    const args = await new Promise<Record<string, string>>((resolve) => output(image.args).apply(resolve));
    const result = run([
      'build', '--file', image.dockerfile, '--target', 'base',
      ...Object.entries(args).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
      context,
    ], { allowFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/(?:exit (?:status|code)|exited with (?:status|code)):? 42/);
  });
});

describe('application source copy', () => {
  it.each(['web', 'workers[queue]', 'reverb'])('%s excludes all .sst content while keeping app files and the generated environment', (label) => {
    const container = startContainer(app.images[label]);
    expect(run(['exec', container, 'test', '!', '-e', '/var/www/html/.sst']).status).toBe(0);
    expect(run(['exec', container, 'cat', '/var/www/html/.app-dotfile']).output.trim()).toBe('keep-me');
    expect(run(['exec', container, 'cat', '/var/www/html/.env']).output).toContain('APP_ENV=production');
    expect(run(['exec', container, 'stat', '-c', '%u', '/var/www/html/artisan']).output.trim()).toBe('33');
  });
});

describe('environment set by ECS', () => {
  // What ECS sets from the env file in S3 and the multi-line secret.
  const variables = {
    APP_NAME: 'My App',
    DB_PASSWORD: 'p$ss #1 "q" \\ end',
    APOSTROPHE: "it's $HOME",
    TABBED: 'a\tb',
    PRIVATE_KEY: '-----BEGIN\nabc\n-----END',
    PLAIN: 'base64:abc=',
  };
  // ECS leaves out MAIL_PASSWORD for being empty; only the list names it.
  const env = { ...variables, SST_LARAVEL_ENV_KEYS: [...Object.keys(variables), 'MAIL_PASSWORD'].join(',') };

  it.each(['web', 'workers[queue]'])('%s writes them to the .env when it starts, readable by www-data only', async (label) => {
    const container = startContainer(app.images[label], undefined, env);

    const written = await waitFor(() => {
      const content = run(['exec', container, 'cat', '/var/www/html/.env'], { allowFailure: true }).output;
      return content.includes('APP_NAME') ? content : undefined;
    }, 60000, 'the .env to be written');

    // Read back the way Laravel reads it: the same values, nothing else.
    expect(loadEnvFile(written)).toEqual({ ...variables, MAIL_PASSWORD: '' });
    expect(run(['exec', container, 'stat', '-c', '%a %u', '/var/www/html/.env']).output.trim()).toBe('600 33');
  });

  it('reach PHP behind nginx', async () => {
    const container = startContainer(app.images.web, 8080, env);
    const port = hostPort(container, 8080);
    const name = encodeURIComponent('DB_PASSWORD');

    const response = await waitFor(async () => {
      const result = await httpGet(port, `/env?name=${name}`);
      return result?.status === 200 ? result : undefined;
    }, 60000, 'the web container to serve /env');

    expect(response.body).toBe(variables.DB_PASSWORD);
  });
});

const expectCleanBoot = (container: string) => {
  const output = logs(container);

  expect(output).not.toMatch(/deprecated/i);
  expect(output).not.toMatch(/permission denied/i);
  expect(output).not.toMatch(/s6-rc-compile: fatal/);
};

describe(`web without background processes (serversideup/php:${phpVersion}-fpm-nginx)`, () => {
  it('serves HTTP, runs only nginx and php-fpm, as www-data', async () => {
    const container = startContainer(plain.images.web, 8080);
    const port = hostPort(container, 8080);

    await waitFor(async () => ((await httpGet(port, '/up'))?.status === 200 ? true : undefined), 60000, 'the web container to serve /up');

    expect(processes(container).some((process) => process.command.includes('artisan'))).toBe(false);
    expect(processes(container).filter((process) => process.uid !== WWW_DATA)).toEqual([]);
    expectCleanBoot(container);
    expect(await stopWithSigterm(container)).toBeLessThan(20000);
    expect(exitCode(container)).toBe(0);
  }, 120000);
});

describe(`web (serversideup/php:${phpVersion}-fpm-nginx)`, () => {
  let container: string;
  let port: number;

  beforeAll(async () => {
    container = startContainer(imageFor(plan('web')), 8080);
    port = hostPort(container, 8080);
    await waitFor(async () => ((await httpGet(port, '/up'))?.status === 200 ? true : undefined), 60000, 'the web container to serve /up');
  }, 120000);

  it('serves HTTP through nginx and php-fpm', async () => {
    expect(await httpGet(port, '/up')).toEqual({ status: 200, body: 'up' });
    expect(processes(container).some((process) => process.command.startsWith('nginx: master'))).toBe(true);
    expect(processes(container).some((process) => process.command.startsWith('php-fpm: master'))).toBe(true);
  });

  it('boots without the deprecated s6 layout', () => {
    expectCleanBoot(container);
    expect(run(['exec', container, 'test', '-e', '/etc/s6-overlay/s6-rc.d/user'], { allowFailure: true }).status).not.toBe(0);
  });

  it('runs every process as www-data', async () => {
    const commands = ['php artisan horizon', SCHEDULER, 'php artisan pulse:work'];
    await waitFor(() => (commands.every((command) => findProcess(container, command)) ? true : undefined), 30000, 'the background processes');

    for (const command of commands) {
      expect(findProcess(container, command)?.uid, command).toBe(WWW_DATA);
    }

    expect(processes(container).filter((process) => process.uid !== WWW_DATA)).toEqual([]);
  });

  it('sends a long log line from PHP-FPM to the container output whole, as one line', async () => {
    // The package's formatter keeps lines under 16 KB.
    const response = await httpGet(port, '/log?bytes=15000');
    const written = Number(response?.body);

    const line = await waitFor(
      () => logs(container).split('\n').find((candidate) => candidate.includes('"message":"long line"')),
      10000,
      'the log line',
    );

    // No php-fpm prefix, no split at ServerSideUp's 8 KB log_limit.
    expect(line.length).toBe(written);
    expect(JSON.parse(line).trace).toHaveLength(15000);
  });

  it('restarts a background process in place, without stopping the container', async () => {
    const pulse = findProcess(container, 'php artisan pulse:work')!;
    kill(container, pulse.pid, 'KILL');

    const restarted = await waitFor(() => {
      const process = findProcess(container, 'php artisan pulse:work');
      return process && process.pid !== pulse.pid ? process : undefined;
    }, 30000, 'pulse to restart');

    expect(restarted.uid).toBe(WWW_DATA);
    expect(isRunning(container)).toBe(true);
    expect((await httpGet(port, '/up'))?.status).toBe(200);
    // The exit, as the line `status --since` reads.
    expect(logs(container).split('\n').map((line) => line.trim()).filter((line) => line.includes('"process_exit"')).map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({ sst_laravel: 'process_exit', process: 'pulse', exit_code: 137, action: 'restart' }));
  });

  it('stops gracefully on SIGTERM', async () => {
    expect(await stopWithSigterm(container)).toBeLessThan(20000);
    expect(exitCode(container)).toBe(0);
  });
});

describe(`worker (serversideup/php:${phpVersion}-cli)`, () => {
  const commands = ['php artisan horizon', SCHEDULER, 'php artisan pulse:work'];

  const startWorker = async () => {
    const container = startContainer(imageFor(plan('workers[queue]')));
    await waitFor(() => (commands.every((command) => findProcess(container, command)) ? true : undefined), 60000, 'the worker processes');
    return container;
  };

  it('runs Horizon, the scheduler, and custom tasks as www-data', async () => {
    const container = await startWorker();

    for (const command of commands) {
      expect(findProcess(container, command)?.uid, command).toBe(WWW_DATA);
    }

    expect(processes(container).filter((process) => process.uid !== WWW_DATA)).toEqual([]);
    expectCleanBoot(container);
  }, 120000);

  it("runs the schedule every minute, with each task's log lines whole", async () => {
    const container = await startWorker();

    // At the start of the next minute.
    const line = await waitFor(
      () => logs(container).split('\n').find((candidate) => candidate.includes('"schedule_finished"')),
      75000,
      'a schedule:run',
    );

    expect(JSON.parse(line)).toMatchObject({ sst_laravel: 'schedule_finished', task: 'php artisan app:report' });
    // The task finishes its line a second later.
    await waitFor(() => (logs(container).includes('  Running [php artisan app:report] DONE') ? true : undefined), 10000, 'the task to finish');
  }, 150000);

  it('restarts a custom task in place', async () => {
    const container = await startWorker();
    const pulse = findProcess(container, 'php artisan pulse:work')!;
    kill(container, pulse.pid, 'KILL');

    await waitFor(() => {
      const process = findProcess(container, 'php artisan pulse:work');
      return process && process.pid !== pulse.pid ? true : undefined;
    }, 30000, 'pulse to restart');

    expect(isRunning(container)).toBe(true);
  }, 120000);

  it.each([
    ['Horizon', 'php artisan horizon'],
    ['the scheduler', SCHEDULER],
  ])('stops the container when %s dies, so ECS replaces it', async (_, command) => {
    const container = await startWorker();
    kill(container, findProcess(container, command)!.pid, 'KILL');

    await waitFor(() => (isRunning(container) ? undefined : true), 30000, 'the container to stop');

    expect(exitCode(container)).toBe(137);
    expect(logs(container)).toContain('exited with code 137. Stopping the container.');
  }, 120000);

  it('stops gracefully on SIGTERM, without the finish scripts stopping it again', async () => {
    const container = await startWorker();

    expect(await stopWithSigterm(container)).toBeLessThan(20000);
    expect(exitCode(container)).toBe(0);
    expect(logs(container)).not.toContain('Stopping the container.');
  }, 120000);
});

describe(`reverb (serversideup/php:${phpVersion}-cli)`, () => {
  it('serves Reverb as www-data', async () => {
    const container = startContainer(imageFor(plan('reverb')), 8080);
    const port = hostPort(container, 8080);

    await waitFor(async () => ((await httpGet(port, '/apps'))?.status === 200 ? true : undefined), 60000, 'Reverb to listen');

    expect(findProcess(container, 'php artisan reverb:start')?.uid).toBe(WWW_DATA);
    expectCleanBoot(container);
  }, 120000);
});

describe('a web image built on a pre-v5 ServerSideUp image', () => {
  it('fails the build instead of skipping the background processes', async () => {
    // Stands in for a stale local copy of the tag.
    const staleTag = `${prefix}-stale`;
    const base = `docker.io/serversideup/php:${staleTag}-fpm-nginx`;
    run(['pull', 'docker.io/serversideup/php:8.4-fpm-nginx-v4.5.1']);
    run(['tag', 'docker.io/serversideup/php:8.4-fpm-nginx-v4.5.1', base]);

    try {
      const web = plan('web');
      const image = buildImage({
        role: 'web',
        sitePath: context,
        absSitePath: context,
        packagePath: packageRoot,
        servicesPath: web.buildPath,
        deployPath: app.deployPath,
      });
      const result = run(
        [
          'build',
          '--file',
          image.dockerfile,
          '--target',
          'deploy',
          '--build-arg',
          `PHP_VERSION=${staleTag}`,
          '--build-arg',
          `CUSTOM_CONF_PATH=${image.args.CUSTOM_CONF_PATH}`,
          '--build-arg',
          `DEPLOY_PATH=${image.args.DEPLOY_PATH}`,
          context,
        ],
        { allowFailure: true },
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toContain('The serversideup/php base image is older than ServerSideUp v5');
    } finally {
      run(['rmi', base], { allowFailure: true });
    }
  }, 15 * 60 * 1000);
});
