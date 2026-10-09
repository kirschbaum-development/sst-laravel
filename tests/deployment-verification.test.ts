import { afterEach, describe, expect, it, vi } from 'vitest';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListServiceDeploymentsCommand } from '@aws-sdk/client-ecs';
import { ECRClient } from '@aws-sdk/client-ecr';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearSavedDeploymentTargets, readDeploymentTargets, readSavedDeploymentTargets, readStatusDeploymentTargets, saveDeploymentTargets } from '../bin/utils/deployment-targets';
import { verifyDeployment } from '../bin/utils/deployment-check';
import { checkTaskImages, parseEcrImage } from '../bin/utils/image-check';

const task = (revision: number) => `arn:aws:ecs:us-east-1:123456789012:task-definition/web:${revision}`;
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/app/web@sha256:${'a'.repeat(64)}`;
const target = { cluster: 'cluster', service: 'web', taskDefinition: task(2) };
const manifest = { version: 1 as const, app: 'app', stage: 'production', services: [target], taskDefinitions: [] as string[] };

function clients({ revision = 2, missing = false, absent = false, desired = 1, images = [image] } = {}) {
  const ecs = { send: vi.fn(async (command) => {
    if (command instanceof DescribeServicesCommand) return { services: absent ? [] : [{
      serviceName: 'web', serviceArn: 'web', status: 'ACTIVE', taskDefinition: task(revision),
      runningCount: desired, desiredCount: desired, pendingCount: 0,
      deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: task(revision), runningCount: desired }],
    }] };
    // No history: a successful old deployment or an expired rollback must not hide the mismatch.
    if (command instanceof ListServiceDeploymentsCommand) return { serviceDeployments: [] };
    if (command instanceof DescribeTaskDefinitionCommand) return { taskDefinition: {
      taskDefinitionArn: command.input.taskDefinition, status: 'ACTIVE',
      containerDefinitions: images.map((image, index) => ({ name: `container${index}`, image })),
    } };
    throw new Error(`Unexpected discovery: ${command.constructor.name}`);
  }) } as unknown as ECSClient;
  const ecr = { send: vi.fn(async (command) => {
    if (missing) throw Object.assign(new Error('missing'), { name: 'ImageNotFoundException' });
    return { imageDetails: [{ imageDigest: command.input.imageIds[0].imageDigest, imageTags: ['latest'] }] };
  }) } as unknown as ECRClient;
  return { ecs, ecr };
}

afterEach(() => vi.unstubAllGlobals());

describe('expected deployment verification', () => {
  async function verify(options: Parameters<typeof clients>[0] = {}, targets = manifest) {
    const { ecs, ecr } = clients(options);
    const fetch = vi.fn(async () => new Response('up'));
    vi.stubGlobal('fetch', fetch);
    const result = await verifyDeployment({
      ecsClient: ecs, ecrClients: () => ecr, clusterArns: ['cluster'], targets,
      url: 'https://example.com', healthPath: '/up', waitSeconds: 0, log: () => {},
    });
    return { result, ecs, ecr, fetch };
  }

  it('checks only registered services and their exact task definitions before health', async () => {
    const { result, ecs, ecr, fetch } = await verify();
    expect(result.verdict).toBe('healthy');
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(ecs.send).mock.calls.find(([command]) => command instanceof DescribeTaskDefinitionCommand)?.[0].input).toEqual({ taskDefinition: task(2) });
    expect(ecr.send).toHaveBeenCalledOnce();
  });

  it('fails when healthy ECS tasks run an older revision, even without rollback history', async () => {
    const { result, fetch } = await verify({ revision: 1 });
    expect(result.verdict).toBe('failed');
    expect(result.rollouts[0].message).toContain('expected web:2');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not accept a different, newer deployment either', async () => {
    expect((await verify({ revision: 3 })).result.verdict).toBe('failed');
  });

  it('fails missing images even when the expected revision is already running', async () => {
    const { result, fetch } = await verify({ missing: true });
    expect(result.verdict).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails a missing expected service', async () => {
    expect((await verify({ absent: true })).result.verdict).toBe('failed');
  });

  it('does not claim a zero-task service is running', async () => {
    expect((await verify({ desired: 0 })).result.verdict).toBe('in-progress');
  });

  it('checks an external task only when explicitly registered', async () => {
    const { ecs } = await verify({}, { ...manifest, taskDefinitions: [task(99)] });
    const reads = vi.mocked(ecs.send).mock.calls.map(([command]) => command).filter((command) => command instanceof DescribeTaskDefinitionCommand);
    expect(reads.map((command) => command.input.taskDefinition)).toEqual([task(2), task(99)]);
  });
});

describe('image availability', () => {
  it('checks every container and uses the repository region and account', async () => {
    const chinaImage = `987654321098.dkr.ecr.cn-north-1.amazonaws.com.cn/sidecar:latest`;
    const { ecs, ecr } = clients({ images: [image, chinaImage, 'nginx:latest', image] });
    const factory = vi.fn(() => ecr);
    expect(await checkTaskImages(ecs, [task(2), task(2)], factory)).toEqual([]);
    expect(factory.mock.calls).toEqual([['us-east-1'], ['cn-north-1']]);
    expect(vi.mocked(ecr.send).mock.calls[1][0].input).toEqual({ registryId: '987654321098', repositoryName: 'sidecar', imageIds: [{ imageTag: 'latest' }] });
  });

  it('fails an empty ECR response and propagates permission failures', async () => {
    const { ecs, ecr } = clients();
    vi.mocked(ecr.send).mockResolvedValueOnce({ imageDetails: [] } as never);
    expect(await checkTaskImages(ecs, [task(2)], () => ecr)).toEqual([expect.stringContaining('ECR image unavailable')]);
    vi.mocked(ecr.send).mockRejectedValueOnce(new Error('Access denied'));
    await expect(checkTaskImages(ecs, [task(2)], () => ecr)).rejects.toThrow('ecr:DescribeImages');
  });

  it('fails when only the sidecar image is missing', async () => {
    const { ecs, ecr } = clients({ images: [image, image.replace('/app/web@', '/sidecar@')] });
    vi.mocked(ecr.send).mockResolvedValueOnce({ imageDetails: [{ imageDigest: `sha256:${'a'.repeat(64)}` }] } as never);
    vi.mocked(ecr.send).mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'RepositoryNotFoundException' }));
    expect(await checkTaskImages(ecs, [task(2)], () => ecr)).toEqual([expect.stringContaining('/sidecar@')]);
  });

  it('prefers a pinned digest over a tag and does not query other registries', () => {
    expect(parseEcrImage(image.replace('/app/web@', '/app/web:release@'))?.imageId).toEqual({ imageDigest: `sha256:${'a'.repeat(64)}` });
    expect(parseEcrImage('public.ecr.aws/nginx/nginx:latest')).toBeUndefined();
  });
});

describe('deployment outputs', () => {
  it('requires an explicit output for the requested stage, without inspecting other outputs', () => {
    expect(() => readDeploymentTargets({ url: 'https://example.com', unrelated: manifest }, 'production')).toThrow('deployment: app.deployment');
    expect(() => readDeploymentTargets({ deployment: manifest }, 'dev')).toThrow('wrong-stage');
    expect(() => readDeploymentTargets({ deployment: { ...manifest, services: [] } }, 'production')).toThrow('No managed services');
    expect(() => readDeploymentTargets({ deployment: { ...manifest, taskDefinitions: ['family-without-revision'] } }, 'production')).toThrow('invalid');
  });

  it('supports multiple components and rejects conflicting revisions', () => {
    const worker = { ...target, service: 'queue' };
    expect(readDeploymentTargets({ deployment: [manifest, { ...manifest, services: [worker] }] }, 'production').services).toEqual([target, worker]);
    expect(() => readDeploymentTargets({ deployment: [manifest, { ...manifest, services: [{ ...target, taskDefinition: task(3) }] }] }, 'production')).toThrow('Conflicting');
  });

  it('saves independent stage expectations and preserves the requested target after rollback', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-targets-'));
    try {
      saveDeploymentTargets(cwd, manifest);
      saveDeploymentTargets(cwd, { ...manifest, stage: 'dev' });
      expect(readSavedDeploymentTargets(cwd, 'production')).toEqual(manifest);
      expect(readStatusDeploymentTargets(cwd, { deployment: { ...manifest, stage: 'dev' } }, 'production')).toEqual(manifest);
      expect(() => readStatusDeploymentTargets(cwd, {}, 'production')).toThrow('deployment: app.deployment');
      clearSavedDeploymentTargets(cwd, 'dev');
      expect(() => readSavedDeploymentTargets(cwd, 'dev')).toThrow('deployment: app.deployment');
      expect(readSavedDeploymentTargets(cwd, 'production')).toEqual(manifest);
      expect(() => readStatusDeploymentTargets(cwd, { deployment: { ...manifest, app: 'different', stage: 'dev' } }, 'production')).toThrow('different SST app');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
