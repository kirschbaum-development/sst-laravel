import { Container, getRandom } from '@cloudflare/containers';
import { env } from 'cloudflare:workers';

type LaravelWorkerEnv = {
  LARAVEL_WEB: DurableObjectNamespace;
  SST_LARAVEL_CONTAINER_ENV_KEYS: string;
  SST_LARAVEL_HEALTH_PATH: string;
  SST_LARAVEL_HTTPS_REDIRECT: string;
  SST_LARAVEL_INSTANCE_COUNT: string;
  SST_LARAVEL_SLEEP_AFTER: string;
  [key: string]: unknown;
};

const bindings = env as LaravelWorkerEnv;

export class LaravelWebContainer extends Container {
  defaultPort = 8080;
  sleepAfter = bindings.SST_LARAVEL_SLEEP_AFTER;
  envVars = buildContainerEnvironment(bindings);

  override async onStart() {
    const healthPath = bindings.SST_LARAVEL_HEALTH_PATH;

    if (!healthPath) {
      return;
    }

    const response = await this.containerFetch(
      `http://localhost${normalizePath(healthPath)}`,
    );

    if (!response.ok) {
      throw new Error(
        `Laravel container health check failed with status ${response.status}.`,
      );
    }
  }
}

export default {
  async fetch(request: Request, workerEnv: LaravelWorkerEnv) {
    if (
      workerEnv.SST_LARAVEL_HTTPS_REDIRECT === 'true' &&
      new URL(request.url).protocol === 'http:'
    ) {
      const url = new URL(request.url);
      url.protocol = 'https:';

      return Response.redirect(url.toString(), 301);
    }

    const instanceCount = Math.max(
      1,
      Number.parseInt(workerEnv.SST_LARAVEL_INSTANCE_COUNT, 10) || 1,
    );
    const container = await getRandom(workerEnv.LARAVEL_WEB, instanceCount);

    return container.fetch(request);
  },
};

function buildContainerEnvironment(workerEnv: LaravelWorkerEnv) {
  const keys = JSON.parse(
    workerEnv.SST_LARAVEL_CONTAINER_ENV_KEYS || '[]',
  ) as string[];

  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = workerEnv[key];

      return typeof value === 'string' ? [[key, value]] : [];
    }),
  );
}

function normalizePath(value: string) {
  return value.startsWith('/') ? value : `/${value}`;
}
