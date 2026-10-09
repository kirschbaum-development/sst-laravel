import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeServiceRevisionsCommand,
  DescribeServicesCommand,
  ECSClient,
  ListServiceDeploymentsCommand,
  ListServicesCommand,
  Service,
  ServiceDeploymentBrief,
} from '@aws-sdk/client-ecs';
import { checkRollouts, evaluateRollout } from '../bin/utils/rollout';
import { verifyDeployment } from '../bin/utils/deployment-check';
import { parseTimeoutSeconds } from '../bin/commands/deploy';
import { parseWaitSeconds } from '../bin/commands/status';

const CLUSTER = 'arn:aws:ecs:us-east-1:123456789012:cluster/shop-production-AppClusterCluster-abc';
const taskDefinition = (revision: number) => `arn:aws:ecs:us-east-1:123456789012:task-definition/App-Web-Task:${revision}`;
const serviceRevision = (revision: number) => `arn:aws:ecs:us-east-1:123456789012:service-revision/web/${revision}`;

/** The web service, settled on a revision. */
const service = (revision: number, overrides: Partial<Service> = {}): Service => ({
  serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/web',
  serviceName: 'App-Web',
  status: 'ACTIVE',
  taskDefinition: taskDefinition(revision),
  desiredCount: 2,
  runningCount: 2,
  pendingCount: 0,
  deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: taskDefinition(revision) }],
  ...overrides,
});

const deployment = (revision: number, status: ServiceDeploymentBrief['status'], statusReason?: string): ServiceDeploymentBrief => ({
  serviceDeploymentArn: `arn:aws:ecs:us-east-1:123456789012:service-deployment/web/${revision}`,
  createdAt: new Date(2026, 9, revision),
  targetServiceRevisionArn: serviceRevision(revision),
  status,
  statusReason,
});

describe('evaluateRollout', () => {
  it('is live when the last deployment succeeded and the service runs its revision', () => {
    expect(evaluateRollout({ service: service(42), deployment: deployment(42, 'SUCCESSFUL'), targetTaskDefinition: taskDefinition(42) })).toEqual({
      service: 'App-Web',
      state: 'live',
      message: 'App-Web-Task:42 is live, 2/2 tasks running',
    });
  });

  it.each(['PENDING', 'IN_PROGRESS'] as const)('is rolling out while the deployment is %s', (status) => {
    const rolling = service(43, {
      runningCount: 1,
      deployments: [
        { status: 'PRIMARY', rolloutState: 'IN_PROGRESS', taskDefinition: taskDefinition(43) },
        { status: 'ACTIVE', rolloutState: 'COMPLETED', taskDefinition: taskDefinition(42) },
      ],
    });

    expect(evaluateRollout({ service: rolling, deployment: deployment(43, status), targetTaskDefinition: taskDefinition(43) })).toMatchObject({
      state: 'rolling-out',
      message: 'rolling out App-Web-Task:43, 1/2 tasks running',
    });
  });

  it('fails a rolled-back deployment, although the previous revision runs healthy', () => {
    // After the rollback the service looks settled: the old revision, every task running.
    const rolledBack = evaluateRollout({
      service: service(42),
      deployment: deployment(43, 'ROLLBACK_SUCCESSFUL', 'ECS deployment circuit breaker: tasks failed to start.'),
      targetTaskDefinition: taskDefinition(43),
    });

    expect(rolledBack).toEqual({
      service: 'App-Web',
      state: 'failed',
      message: 'the deployment of App-Web-Task:43 failed and ECS rolled back to the previous revision: ECS deployment circuit breaker: tasks failed to start.',
    });
  });

  it.each([
    ['ROLLBACK_REQUESTED', 'is rolling back'],
    ['ROLLBACK_IN_PROGRESS', 'is rolling back'],
    ['ROLLBACK_FAILED', 'and so did the rollback'],
    ['STOP_REQUESTED', 'was stopped'],
    ['STOPPED', 'was stopped'],
  ] as const)('fails as soon as the deployment is %s', (status, message) => {
    const result = evaluateRollout({ service: service(42), deployment: deployment(43, status), targetTaskDefinition: taskDefinition(43) });

    expect(result.state).toBe('failed');
    expect(result.message).toContain(message);
  });

  it('waits when the service runs a newer revision than the last deployment ECS lists', () => {
    expect(evaluateRollout({ service: service(43), deployment: deployment(42, 'SUCCESSFUL'), targetTaskDefinition: taskDefinition(42) })).toMatchObject({
      state: 'rolling-out',
      message: 'waiting for ECS to start rolling out App-Web-Task:43',
    });
  });

  it('waits until every task the service wants is running', () => {
    expect(
      evaluateRollout({ service: service(42, { runningCount: 1 }), deployment: deployment(42, 'SUCCESSFUL'), targetTaskDefinition: taskDefinition(42) }),
    ).toMatchObject({ state: 'rolling-out', message: 'App-Web-Task:42 is deployed, 1/2 tasks running' });
  });

  describe('without a deployment in the last 90 days', () => {
    it('is live when the service is settled', () => {
      expect(evaluateRollout({ service: service(42) }).state).toBe('live');
    });

    it('fails when its current deployment failed', () => {
      const failed = service(43, {
        deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED', rolloutStateReason: 'tasks failed to start', taskDefinition: taskDefinition(43) }],
      });

      expect(evaluateRollout({ service: failed })).toMatchObject({
        state: 'failed',
        message: 'the deployment of App-Web-Task:43 failed: tasks failed to start',
      });
    });

    it('is rolling out while two deployments run', () => {
      const rolling = service(43, {
        deployments: [
          { status: 'PRIMARY', rolloutState: 'IN_PROGRESS', taskDefinition: taskDefinition(43) },
          { status: 'ACTIVE', rolloutState: 'COMPLETED', taskDefinition: taskDefinition(42) },
        ],
      });

      expect(evaluateRollout({ service: rolling }).state).toBe('rolling-out');
    });
  });
});

interface EcsState {
  services: Service[];
  deployments: Record<string, ServiceDeploymentBrief[]>;
}

/** An ECS client that answers from `state()`, read on every call. */
const fakeEcs = (state: () => EcsState) =>
  ({
    send: vi.fn(async (command: unknown) => {
      const current = state();

      if (command instanceof ListServicesCommand) {
        return { serviceArns: current.services.map((candidate) => candidate.serviceArn) };
      }

      if (command instanceof DescribeServicesCommand) {
        return { services: current.services.filter((candidate) => command.input.services?.includes(candidate.serviceArn!)) };
      }

      if (command instanceof ListServiceDeploymentsCommand) {
        return { serviceDeployments: current.deployments[command.input.service!] ?? [] };
      }

      if (command instanceof DescribeServiceRevisionsCommand) {
        return {
          serviceRevisions: command.input.serviceRevisionArns!.map((arn) => ({
            serviceRevisionArn: arn,
            taskDefinition: taskDefinition(Number(arn.split('/').pop())),
          })),
        };
      }

      throw new Error(`Unexpected command ${(command as object).constructor.name}`);
    }),
  }) as unknown as ECSClient;

const WEB = 'arn:aws:ecs:us-east-1:123456789012:service/web';

describe('checkRollouts', () => {
  it('takes the newest deployment, whatever order ECS lists them in', async () => {
    const ecs = fakeEcs(() => ({
      services: [service(42)],
      deployments: { [WEB]: [deployment(41, 'SUCCESSFUL'), deployment(43, 'ROLLBACK_SUCCESSFUL'), deployment(42, 'SUCCESSFUL')] },
    }));

    expect((await checkRollouts(ecs, CLUSTER))[0].state).toBe('failed');
  });

  it('skips services that are being deleted', async () => {
    const ecs = fakeEcs(() => ({ services: [service(42, { status: 'DRAINING' })], deployments: {} }));

    expect(await checkRollouts(ecs, CLUSTER)).toEqual([]);
  });

  it('names the permissions the check needs when AWS denies it', async () => {
    const ecs = {
      send: async () => {
        throw Object.assign(new Error('User is not authorized to perform: ecs:ListServiceDeployments'), { name: 'AccessDeniedException' });
      },
    } as unknown as ECSClient;

    await expect(checkRollouts(ecs, CLUSTER)).rejects.toThrow(
      'The check needs ecs:ListServices, ecs:DescribeServices, ecs:ListServiceDeployments, ecs:DescribeServiceRevisions.',
    );
  });
});

describe('verifyDeployment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs the check against a sequence of ECS states, one per poll. */
  const verify = async (states: EcsState[], options: { waitSeconds?: number; url?: string } = {}) => {
    let poll = 0;
    let clock = 0;
    const lines: string[] = [];
    const fetch = vi.fn(async () => new Response('up', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await verifyDeployment({
      ecsClient: fakeEcs(() => states[Math.min(poll, states.length - 1)]),
      clusterArns: [CLUSTER],
      url: options.url ?? 'https://app.example.com',
      healthPath: '/up',
      waitSeconds: options.waitSeconds ?? 1800,
      log: (line) => lines.push(line),
      sleep: async (ms) => {
        poll += 1;
        clock += ms;
      },
      now: () => clock,
    });

    return { ...result, polls: poll + 1, lines, fetch };
  };

  const rollingOut: EcsState = {
    services: [
      service(43, {
        runningCount: 1,
        deployments: [
          { status: 'PRIMARY', rolloutState: 'IN_PROGRESS', taskDefinition: taskDefinition(43) },
          { status: 'ACTIVE', rolloutState: 'COMPLETED', taskDefinition: taskDefinition(42) },
        ],
      }),
    ],
    deployments: { [WEB]: [deployment(42, 'SUCCESSFUL'), deployment(43, 'IN_PROGRESS')] },
  };
  const live: EcsState = { services: [service(43)], deployments: { [WEB]: [deployment(42, 'SUCCESSFUL'), deployment(43, 'SUCCESSFUL')] } };
  const rolledBack: EcsState = {
    services: [service(42)],
    deployments: { [WEB]: [deployment(42, 'SUCCESSFUL'), deployment(43, 'ROLLBACK_SUCCESSFUL', 'tasks failed to start')] },
  };

  it('waits for the rollout, then checks the health endpoint', async () => {
    const result = await verify([rollingOut, rollingOut, live]);

    expect(result.verdict).toBe('healthy');
    expect(result.polls).toBe(3);
    // The previous revision answers until the rollout is done, so the URL proves nothing before.
    expect(result.fetch).toHaveBeenCalledTimes(1);
    expect(result.lines).toContain('[ok] App-Web: App-Web-Task:43 is live, 2/2 tasks running\n[ok] health: GET /up returned 200');
  });

  it('fails as soon as ECS rolls back, while the previous revision still answers', async () => {
    const result = await verify([rollingOut, rolledBack, live]);

    expect(result.verdict).toBe('failed');
    expect(result.polls).toBe(2);
    expect(result.lines.join('\n')).toContain(
      '[FIX] App-Web: the deployment of App-Web-Task:43 failed and ECS rolled back to the previous revision: tasks failed to start',
    );
  });

  it('fails a rollback that finished before the first check', async () => {
    expect((await verify([rolledBack])).verdict).toBe('failed');
  });

  it('times out when the rollout does not finish in time', async () => {
    const result = await verify([rollingOut], { waitSeconds: 60 });

    expect(result.verdict).toBe('timed-out');
    expect(result.polls).toBe(5);
  });

  it('checks once without waiting', async () => {
    expect((await verify([rollingOut], { waitSeconds: 0 })).verdict).toBe('in-progress');
    expect((await verify([live], { waitSeconds: 0 })).verdict).toBe('healthy');
  });

  it('fails when the health endpoint errors once the rollout is live', async () => {
    let clock = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));

    const result = await verifyDeployment({
      ecsClient: fakeEcs(() => live),
      clusterArns: [CLUSTER],
      url: 'https://app.example.com',
      healthPath: '/up',
      waitSeconds: 1800,
      log: () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    expect(result.verdict).toBe('failed');
  });

  it('fails when the cluster has no services', async () => {
    expect((await verify([{ services: [], deployments: {} }])).verdict).toBe('failed');
  });
});

describe('wait options', () => {
  it('waits 30 minutes unless told otherwise', () => {
    expect(parseTimeoutSeconds(undefined)).toBe(1800);
    expect(parseTimeoutSeconds('600')).toBe(600);
    expect(parseTimeoutSeconds('nope')).toBe(1800);
    expect(parseWaitSeconds(true)).toBe(1800);
    expect(parseWaitSeconds(undefined)).toBe(0);
    expect(parseWaitSeconds('120')).toBe(120);
  });
});
