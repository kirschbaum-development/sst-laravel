import type { ECSClient } from '@aws-sdk/client-ecs';
import { checkRollouts, ServiceRollout } from './rollout.js';
import { ECRClient } from '@aws-sdk/client-ecr';
import type { DeploymentTargets } from './deployment-targets.js';
import { checkTaskImages, EcrClients } from './image-check.js';

export const DEFAULT_WAIT_SECONDS = 1800;
export const RETRY_SECONDS = 15;

/**
 * Without a domain, the app runs on the load balancer address over plain
 * http: port 443 is not open, so an https:// URL times out silently.
 */
export const isLoadBalancerHttpsUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.elb.amazonaws.com');
  } catch {
    return false;
  }
};

export type HealthState = 'ok' | 'starting' | 'failed' | 'skipped';

export interface HealthResult {
  state: HealthState;
  lines: string[];
}

/** One request to the health endpoint. */
export async function checkHealth(url: string | undefined, healthPath: string): Promise<HealthResult> {
  if (!url) {
    return {
      state: 'skipped',
      lines: ['[--] health: skipped (no app URL for this stage: pass --url <app-url>, or deploy with `npx sst-laravel deploy` to save it)'],
    };
  }

  const target = `${url.replace(/\/$/, '')}${healthPath}`;

  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(15000) });

    if (response.ok) {
      return { state: 'ok', lines: [`[ok] health: GET ${healthPath} returned ${response.status}`] };
    }

    if (response.status === 502 || response.status === 503) {
      // The load balancer answers 502/503 while no task is healthy yet.
      return {
        state: 'starting',
        lines: [`[FIX] health: GET ${healthPath} returned ${response.status}. The load balancer has no healthy task yet; right after a deploy that usually means the task is still starting.`],
      };
    }

    return {
      state: 'failed',
      lines: [`[FIX] health: GET ${healthPath} returned ${response.status}. Check env vars, migrations, and recent logs.`],
    };
  } catch (error) {
    const lines = [`[FIX] health: could not reach ${target} (${(error as Error).message}).`];

    if (isLoadBalancerHttpsUrl(url)) {
      lines.push('      This is the load balancer address, which only serves http:// until you add a domain. Retry with http://.');
      return { state: 'failed', lines };
    }

    lines.push('      The load balancer can take a few minutes after a deploy. If it persists, check target health and logs.');
    return { state: 'starting', lines };
  }
}

const ROLLOUT_MARK = { live: 'ok', 'rolling-out': '..', failed: 'FIX' } as const;

export const formatRollout = (rollout: ServiceRollout) => `[${ROLLOUT_MARK[rollout.state]}] ${rollout.service}: ${rollout.message}`;

export type DeploymentVerdict = 'healthy' | 'failed' | 'in-progress' | 'timed-out';

export interface DeploymentCheckOptions {
  ecsClient: ECSClient;
  clusterArns: string[];
  targets?: DeploymentTargets;
  ecrClients?: EcrClients;
  url?: string;
  healthPath: string;
  /** Keep checking while the rollout is in progress, up to this long. 0 checks once. */
  waitSeconds: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DeploymentCheckResult {
  verdict: DeploymentVerdict;
  rollouts: ServiceRollout[];
  health: HealthResult;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * With targets, checks the exact expected revisions and their private ECR
 * images. Without them, provides ECS-history diagnostics for an explicit
 * cluster. Waits for rollouts and checks the health endpoint last.
 *
 * A healthy URL alone proves nothing after a deploy: until the new tasks
 * pass their health checks, and after ECS rolls a failed deployment back,
 * the previous revision answers. So the deployments decide, and the URL is
 * only checked once they are live.
 */
export async function verifyDeployment(options: DeploymentCheckOptions): Promise<DeploymentCheckResult> {
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.waitSeconds * 1000;
  const clients = new Map<string, ECRClient>();
  const ecrClients = options.ecrClients ?? ((region: string) => {
    if (!clients.has(region)) clients.set(region, new ECRClient({ region }));
    return clients.get(region)!;
  });
  let previousReport = '';

  for (;;) {
    const rollouts: ServiceRollout[] = [];

    const clusterArns = options.targets
      ? [...new Set(options.targets.services.map((target) => target.cluster))]
      : options.clusterArns;
    for (const clusterArn of clusterArns) {
      rollouts.push(...(await checkRollouts(options.ecsClient, clusterArn,
        options.targets?.services.filter((target) => target.cluster === clusterArn))));
    }

    const missingImages = options.targets ? await checkTaskImages(options.ecsClient,
      [...options.targets.services.map((target) => target.taskDefinition), ...options.targets.taskDefinitions], ecrClients) : [];
    const failed = rollouts.some((rollout) => rollout.state === 'failed') || missingImages.length > 0;
    const live = rollouts.length > 0 && rollouts.every((rollout) => rollout.state === 'live');
    const health: HealthResult =
      !failed && (live || options.waitSeconds === 0)
        ? await checkHealth(options.url, options.healthPath)
        : { state: 'starting', lines: ['[..] health: checked once every service is live'] };

    const lines = rollouts.length > 0 ? rollouts.map(formatRollout) : ['[FIX] services: none found in the cluster.'];
    lines.push(...missingImages.map((message) => `[FIX] ${message}`));
    const report = [...lines, ...health.lines].join('\n');

    if (report !== previousReport) {
      log(report);
      previousReport = report;
    }

    const result = (verdict: DeploymentVerdict): DeploymentCheckResult => ({ verdict, rollouts, health });

    if (failed || health.state === 'failed' || rollouts.length === 0) {
      return result('failed');
    }

    if (live && health.state !== 'starting') {
      return result('healthy');
    }

    if (options.waitSeconds === 0) {
      return result('in-progress');
    }

    if (now() >= deadline) {
      return result('timed-out');
    }

    const left = Math.round((deadline - now()) / 1000);
    log(`Still rolling out. Checking again in ${RETRY_SECONDS}s (up to ${left}s more)...`);
    await sleep(RETRY_SECONDS * 1000);
  }
}
