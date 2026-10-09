import {
  DescribeServiceRevisionsCommand,
  DescribeServicesCommand,
  ECSClient,
  ListServiceDeploymentsCommand,
  ListServicesCommand,
  Service,
  ServiceDeploymentBrief,
} from '@aws-sdk/client-ecs';

/**
 * - `live`: the service runs the revision of its last deployment, with every
 *   task it wants.
 * - `rolling-out`: ECS is still replacing the tasks.
 * - `failed`: the last deployment failed, was rolled back, or was stopped.
 *   The service may be healthy on the previous revision, but not on the one
 *   that was deployed.
 */
export type RolloutState = 'live' | 'rolling-out' | 'failed';

export interface ServiceRollout {
  /** The ECS service name, `<component>-Web` for example. */
  service: string;
  state: RolloutState;
  /** What the report says about the service. */
  message: string;
}

/** What ECS says about one service. */
export interface RolloutFacts {
  service: Service;
  /** The last service deployment. ECS keeps them for 90 days. */
  deployment?: ServiceDeploymentBrief;
  /** The task definition that deployment rolls out. */
  targetTaskDefinition?: string;
}

/** `App-Web-Task:42` from a task definition ARN. */
export const taskDefinitionRevision = (arn?: string): string => arn?.split('/').pop() ?? 'unknown';

/**
 * Decides whether the last deployment of a service is live. ECS records a
 * circuit-breaker rollback on the deployment itself (`ROLLBACK_*`), so a
 * rolled-back service fails here even though it runs, and passes health
 * checks, on the previous revision.
 */
export function evaluateRollout({ service, deployment, targetTaskDefinition }: RolloutFacts): ServiceRollout {
  const name = service.serviceName ?? 'unknown';
  const running = service.runningCount ?? 0;
  const desired = service.desiredCount ?? 0;
  const tasks = `${running}/${desired} tasks running`;
  const target = taskDefinitionRevision(targetTaskDefinition ?? service.taskDefinition);
  const reason = deployment?.statusReason ? `: ${deployment.statusReason}` : '';
  const result = (state: RolloutState, message: string): ServiceRollout => ({ service: name, state, message });

  switch (deployment?.status) {
    case 'PENDING':
    case 'IN_PROGRESS':
      return result('rolling-out', `rolling out ${target}, ${tasks}`);
    case 'ROLLBACK_REQUESTED':
    case 'ROLLBACK_IN_PROGRESS':
      return result('failed', `the deployment of ${target} failed and ECS is rolling back to the previous revision${reason}`);
    case 'ROLLBACK_SUCCESSFUL':
      return result('failed', `the deployment of ${target} failed and ECS rolled back to the previous revision${reason}`);
    case 'ROLLBACK_FAILED':
      return result('failed', `the deployment of ${target} failed, and so did the rollback${reason}`);
    case 'STOP_REQUESTED':
    case 'STOPPED':
      return result('failed', `the deployment of ${target} was stopped${reason}`);
  }

  // A successful deployment, or none in the last 90 days: check what the
  // service runs now.
  if (deployment && targetTaskDefinition && service.taskDefinition !== targetTaskDefinition) {
    // ECS lists a new deployment a moment after the service changes.
    return result('rolling-out', `waiting for ECS to start rolling out ${taskDefinitionRevision(service.taskDefinition)}`);
  }

  const primary = service.deployments?.find((candidate) => candidate.status === 'PRIMARY');

  if (primary?.rolloutState === 'FAILED') {
    const primaryReason = primary.rolloutStateReason ? `: ${primary.rolloutStateReason}` : '';
    return result('failed', `the deployment of ${taskDefinitionRevision(primary.taskDefinition)} failed${primaryReason}`);
  }

  if ((service.deployments?.length ?? 0) > 1 || primary?.rolloutState === 'IN_PROGRESS') {
    return result('rolling-out', `rolling out ${taskDefinitionRevision(primary?.taskDefinition ?? service.taskDefinition)}, ${tasks}`);
  }

  if (running !== desired || (service.pendingCount ?? 0) > 0) {
    return result('rolling-out', `${target} is deployed, ${tasks}`);
  }

  return result('live', `${target} is live, ${tasks}`);
}

const isAccessDenied = (error: unknown) =>
  (error as { name?: string })?.name === 'AccessDeniedException' || (error as { name?: string })?.name === 'AccessDenied';

/**
 * The IAM actions the rollout check needs, for the error when one is
 * missing.
 */
export const ROLLOUT_PERMISSIONS = [
  'ecs:ListServices',
  'ecs:DescribeServices',
  'ecs:ListServiceDeployments',
  'ecs:DescribeServiceRevisions',
];

async function listServiceArns(ecsClient: ECSClient, clusterArn: string): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(new ListServicesCommand({ cluster: clusterArn, nextToken }));
    arns.push(...(response.serviceArns ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return arns;
}

async function latestDeployment(ecsClient: ECSClient, clusterArn: string, serviceArn: string) {
  let latest: ServiceDeploymentBrief | undefined;
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(
      new ListServiceDeploymentsCommand({ cluster: clusterArn, service: serviceArn, nextToken }),
    );

    for (const deployment of response.serviceDeployments ?? []) {
      if (!latest || (deployment.createdAt?.getTime() ?? 0) > (latest.createdAt?.getTime() ?? 0)) {
        latest = deployment;
      }
    }

    nextToken = response.nextToken;
  } while (nextToken);

  return latest;
}

async function revisionTaskDefinition(ecsClient: ECSClient, serviceRevisionArn?: string) {
  if (!serviceRevisionArn) {
    return undefined;
  }

  const response = await ecsClient.send(new DescribeServiceRevisionsCommand({ serviceRevisionArns: [serviceRevisionArn] }));

  return response.serviceRevisions?.[0]?.taskDefinition;
}

/**
 * The rollout of every service in the cluster: web, Reverb, and the
 * workers.
 */
export async function checkRollouts(ecsClient: ECSClient, clusterArn: string): Promise<ServiceRollout[]> {
  try {
    const serviceArns = await listServiceArns(ecsClient, clusterArn);
    const services: Service[] = [];

    // DescribeServices takes up to 10 services at a time.
    for (let i = 0; i < serviceArns.length; i += 10) {
      const response = await ecsClient.send(
        new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns.slice(i, i + 10) }),
      );
      services.push(...(response.services ?? []));
    }

    const rollouts: ServiceRollout[] = [];

    for (const service of services.filter((candidate) => candidate.status === 'ACTIVE')) {
      const deployment = await latestDeployment(ecsClient, clusterArn, service.serviceArn!);
      const targetTaskDefinition = await revisionTaskDefinition(ecsClient, deployment?.targetServiceRevisionArn);

      rollouts.push(evaluateRollout({ service, deployment, targetTaskDefinition }));
    }

    return rollouts.sort((a, b) => a.service.localeCompare(b.service));
  } catch (error) {
    if (isAccessDenied(error)) {
      throw new Error(
        `Not allowed to read the ECS deployments (${(error as Error).message}). The check needs ${ROLLOUT_PERMISSIONS.join(', ')}.`,
      );
    }

    throw error;
  }
}
