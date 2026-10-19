import { asset, ComponentResource, Output } from '@pulumi/pulumi';

/**
 * The function that records the cluster's ECS events. It logs each event as
 * a JSON string; Lambda's JSON log format, with platform logs at WARN, keeps
 * the log group to one line per event.
 *
 * It keeps only the fields `sst-laravel status` reads, and nothing a task was
 * started with: the event of a task has its overrides, and those of a task
 * runner can hold secrets in their environment or command.
 */
export const ECS_EVENT_RECORDER_SOURCE = `const TASK = ['clusterArn', 'taskArn', 'group', 'taskDefinitionArn', 'lastStatus', 'desiredStatus', 'launchType',
  'capacityProviderName', 'availabilityZone', 'createdAt', 'startedAt', 'stoppingAt', 'stoppedAt', 'stopCode', 'stoppedReason', 'version'];
const CONTAINER = ['name', 'lastStatus', 'exitCode', 'reason'];
const SERVICE = ['eventType', 'eventName', 'deploymentId', 'clusterArn', 'createdAt', 'updatedAt', 'reason'];

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));

export const handler = async (event) => {
  const detail = event.detail ?? {};
  const kept = event['detail-type'] === 'ECS Task State Change'
    ? { ...pick(detail, TASK), containers: (detail.containers ?? []).map((container) => pick(container, CONTAINER)) }
    : pick(detail, SERVICE);

  console.log(JSON.stringify({ time: event.time, source: event.source, 'detail-type': event['detail-type'], resources: event.resources, detail: kept }));
};
`;

/** The log group, under the cluster's like SST's container log groups, so the CLI finds it the same way. */
export const ecsEventsLogGroupName = (clusterName: string) => `/sst/cluster/${clusterName}/sst-laravel/ecs-events`;

/** Days the recorded events are kept, like SST's container logs. */
export const ECS_EVENTS_RETENTION_DAYS = 30;

/** Every task of the cluster that stopped, services' and standalone tasks' (task runners). */
export function stoppedTaskPattern(clusterArn: string) {
  return {
    source: ['aws.ecs'],
    'detail-type': ['ECS Task State Change'],
    detail: { clusterArn: [clusterArn], lastStatus: ['STOPPED'] },
  };
}

/** The deployment and service events of the cluster's services, matched by their ARN. */
export function serviceEventPattern(clusterArn: string) {
  return {
    source: ['aws.ecs'],
    'detail-type': ['ECS Deployment State Change', 'ECS Service Action'],
    resources: [{ prefix: `${clusterArn.replace(':cluster/', ':service/')}/` }],
  };
}

export function recorderPolicy(logGroupArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `${logGroupArn}:*` }],
  };
}

/**
 * Records the ECS events of the cluster in CloudWatch Logs: tasks that
 * stopped, with their stop code, reason, and exit codes, deployments, and
 * service actions. ECS lists stopped tasks for about an hour only, so
 * without them `sst-laravel status --since 24h` couldn't tell restarts and
 * crashes apart. EventBridge sends them to a small function rather than
 * straight to the log group: that would need a CloudWatch Logs resource
 * policy, of which an account has 10 per region.
 */
export function createEcsEventRecorder(parent: ComponentResource, name: string, cluster: { arn: Output<string>; name: Output<string> }) {
  const opts = { parent };
  const logGroup = new aws.cloudwatch.LogGroup(
    `${name}-EcsEvents`,
    {
      name: cluster.name.apply(ecsEventsLogGroupName),
      retentionInDays: ECS_EVENTS_RETENTION_DAYS,
    },
    opts,
  );

  const role = new aws.iam.Role(
    `${name}-EcsEventsRole`,
    {
      description: `Records the ECS events of the ${name} cluster (sst-laravel).`,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
      inlinePolicies: [{ name: 'logs', policy: logGroup.arn.apply((arn) => JSON.stringify(recorderPolicy(arn))) }],
    },
    opts,
  );

  const recorder = new aws.lambda.Function(
    `${name}-EcsEventsRecorder`,
    {
      description: `Records the ECS events of the ${name} cluster in CloudWatch Logs (sst-laravel).`,
      runtime: 'nodejs22.x',
      architectures: ['arm64'],
      handler: 'index.handler',
      memorySize: 128,
      timeout: 10,
      role: role.arn,
      code: new asset.AssetArchive({ 'index.mjs': new asset.StringAsset(ECS_EVENT_RECORDER_SOURCE) }),
      loggingConfig: {
        logFormat: 'JSON',
        logGroup: logGroup.name,
        applicationLogLevel: 'INFO',
        systemLogLevel: 'WARN',
      },
    },
    { ...opts, dependsOn: [logGroup] },
  );

  const rules: Record<string, Output<string>> = {
    StoppedTasks: cluster.arn.apply((arn) => JSON.stringify(stoppedTaskPattern(arn))),
    ServiceEvents: cluster.arn.apply((arn) => JSON.stringify(serviceEventPattern(arn))),
  };

  for (const [suffix, pattern] of Object.entries(rules)) {
    const rule = new aws.cloudwatch.EventRule(
      `${name}-EcsEvents${suffix}`,
      {
        description: `Sends the ECS events of the ${name} cluster to its recorder (sst-laravel).`,
        eventPattern: pattern,
      },
      opts,
    );

    new aws.lambda.Permission(
      `${name}-EcsEvents${suffix}Permission`,
      {
        action: 'lambda:InvokeFunction',
        function: recorder.name,
        principal: 'events.amazonaws.com',
        sourceArn: rule.arn,
      },
      opts,
    );

    new aws.cloudwatch.EventTarget(
      `${name}-EcsEvents${suffix}Target`,
      { rule: rule.name, arn: recorder.arn },
      opts,
    );
  }

  return { logGroupName: logGroup.name, recorder };
}
