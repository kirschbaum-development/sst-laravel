import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeServicesCommand, ECSClient, ListServiceDeploymentsCommand, ListServicesCommand, ListTasksCommand, Service } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';

/**
 * Runs `status` as a user would, against fake AWS clients: what it prints
 * on stdout and the code it exits with.
 */

const CLUSTER = 'recon-production-TaskRunnerClusterCluster-sscnmwxb';
const EVENTS_GROUP = `/sst/cluster/${CLUSTER}/sst-laravel/ecs-events`;
const NOW = Date.now();

const stoppedEvent = (taskId: string, exitCode: number) => ({
  'detail-type': 'ECS Task State Change',
  source: 'aws.ecs',
  detail: {
    taskArn: `arn:aws:ecs:us-east-1:123456789012:task/${CLUSTER}/${taskId}`,
    group: 'family:recon-production-Import',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/recon-production-Import:3',
    lastStatus: 'STOPPED',
    stopCode: 'EssentialContainerExited',
    stoppedAt: new Date(NOW - 3600000).toISOString(),
    containers: [{ name: 'Import', exitCode }],
  },
});

interface FakeAws {
  services?: Service[];
  logGroups?: string[];
  events?: unknown[];
  /** The `deployment` output of the app in the working directory. */
  deployment?: unknown;
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

async function runStatus(args: string[], aws: FakeAws) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-status-'));
  if (aws.deployment) {
    fs.mkdirSync(path.join(app, '.sst'));
    fs.writeFileSync(path.join(app, '.sst', 'outputs.json'), JSON.stringify({ deployment: aws.deployment }));
  }
  vi.spyOn(process, 'cwd').mockReturnValue(app);

  vi.spyOn(ECSClient.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof ListServicesCommand) return { serviceArns: (aws.services ?? []).map((service) => service.serviceArn) };
    if (command instanceof DescribeServicesCommand) return { services: aws.services ?? [] };
    if (command instanceof ListServiceDeploymentsCommand) return { serviceDeployments: [] };
    if (command instanceof ListTasksCommand) return { taskArns: [] };
    return {};
  }) as any);
  vi.spyOn(CloudWatchLogsClient.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof DescribeLogGroupsCommand) return { logGroups: (aws.logGroups ?? []).map((logGroupName) => ({ logGroupName })) };
    if (command instanceof FilterLogEventsCommand) {
      return { events: (aws.events ?? []).map((event, i) => ({ timestamp: NOW - 3600000, logStreamName: 's', eventId: String(i), message: JSON.stringify(event) })) };
    }
    throw new Error(`unexpected CloudWatch Logs call ${(command as object).constructor.name}`);
  }) as any);
  vi.spyOn(CloudWatchClient.prototype, 'send').mockImplementation((async () => ({ MetricAlarms: [], CompositeAlarms: [] })) as any);
  vi.spyOn(ElasticLoadBalancingV2Client.prototype, 'send').mockImplementation((async () => ({ TargetGroups: [] })) as any);

  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: () => void) => {
    stdout += chunk;
    callback?.();
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((_chunk: string, callback?: () => void) => {
    callback?.();
    return true;
  }) as any);
  // The action catches the throw of its own exit, and exits again: the first one counts.
  const exits: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    exits.push(code);
    throw new Exit(code);
  }) as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // A fresh command each run: commander keeps the options of the last parse.
  vi.resetModules();
  const { statusCommand } = await import('../bin/commands/status');
  try {
    await statusCommand.parseAsync(['--region', 'us-east-1', ...args], { from: 'user' });
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
  }

  return { code: exits[0] ?? 0, json: stdout ? JSON.parse(stdout) : undefined };
}

describe('status --cluster for a cluster of one-off tasks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is healthy when nothing stopped unexpectedly, though the cluster has no services', async () => {
    const { code, json } = await runStatus(['--cluster', CLUSTER, '--since', '24h', '--json'], {
      logGroups: [EVENTS_GROUP],
      events: [stoppedEvent('aaaa', 0)],
    });

    expect(json).toMatchObject({ healthy: true, attention: [], deployment: { verdict: 'healthy', rollouts: [] } });
    expect(json.history[0].stoppedTasks).toMatchObject({ source: 'ecs-events', tasks: [{ taskId: 'aaaa', category: 'completed' }] });
    expect(code).toBe(0);
  });

  it('needs attention for a task that crashed, and says so', async () => {
    const { code, json } = await runStatus(['--cluster', CLUSTER, '--since', '24h', '--json'], {
      logGroups: [EVENTS_GROUP],
      events: [stoppedEvent('aaaa', 0), stoppedEvent('bbbb', 1)],
    });

    expect(json.healthy).toBe(false);
    expect(json.attention).toEqual([expect.stringMatching(/^recon-production-Import: 1 task stopped unexpectedly/)]);
    expect(code).toBe(1);
  });

  it('points a cluster without the events log group at EcsEventRecorder', async () => {
    const { json } = await runStatus(['--cluster', CLUSTER, '--since', '24h', '--json'], {});

    expect(json.history[0].stoppedTasks.source).toBe('ecs');
    expect(json.history[0].stoppedTasks.note).toContain('EcsEventRecorder');
  });
});

describe('status needing attention', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always says why in the attention list', async () => {
    const web: Service = {
      serviceArn: `arn:aws:ecs:us-east-1:123456789012:service/${CLUSTER}/App-Web`,
      serviceName: 'App-Web',
      status: 'ACTIVE',
      taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/App-Web-Task:4',
      runningCount: 0,
      desiredCount: 1,
      deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED', rolloutStateReason: 'tasks failed to start', taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/App-Web-Task:4' }],
    };
    const { code, json } = await runStatus(['--cluster', CLUSTER, '--json'], { services: [web] });

    expect(json).toMatchObject({ healthy: false, deployment: { verdict: 'failed' } });
    expect(json.attention).toEqual(['App-Web: the deployment of App-Web-Task:4 failed: tasks failed to start']);
    expect(code).toBe(1);
  });
});

describe('status --stage --cluster', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const APP_CLUSTER = 'recon-production-AppClusterCluster-abcdefgh';
  const deployment = {
    version: 1, app: 'recon', stage: 'production', taskDefinitions: [],
    services: [{
      cluster: `arn:aws:ecs:us-east-1:123456789012:cluster/${APP_CLUSTER}`,
      service: `arn:aws:ecs:us-east-1:123456789012:service/${APP_CLUSTER}/App-Web`,
      taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/App-Web-Task:4',
    }],
  };

  it("verifies the stage's services in its cluster named by name, as the outputs name it by ARN", async () => {
    const { code, json } = await runStatus(['--stage', 'production', '--cluster', APP_CLUSTER, '--json'], { deployment });

    expect(json.verified).toBe(true);
    expect(code).not.toBe(2);
  });

  it('checks a cluster without any of the stage services on its own', async () => {
    const { code, json } = await runStatus(['--stage', 'production', '--cluster', CLUSTER, '--since', '24h', '--json'], {
      deployment,
      logGroups: [EVENTS_GROUP],
      events: [stoppedEvent('aaaa', 0)],
    });

    expect(json).toMatchObject({ verified: false, healthy: true, attention: [] });
    expect(code).toBe(0);
  });
});
