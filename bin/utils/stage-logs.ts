import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient } from '@aws-sdk/client-ecs';
import { CliError, info } from './cli.js';
import { findCluster } from './ecs.js';
import { ClusterLogGroups, clusterNameFromArn, discoverLogGroups } from './log-sources.js';
import { extractLaravelComponents, findSstConfig, resolveAppRegion } from './sst-config.js';

export interface StageOptions {
  stage?: string;
  cluster?: string;
  region?: string;
}

export interface StageLogs extends ClusterLogGroups {
  region: string;
  clusterArn: string;
  clusterName: string;
  /** The `LaravelService` name, when sst.config.ts has exactly one. */
  component?: string;
  ecs: ECSClient;
  logs: CloudWatchLogsClient;
}

/**
 * The cluster of the stage and its log groups, found by name: it needs no
 * running task, no SST outputs, and no previous deploy from this machine, so
 * it works when the app is crash-looping or scaled to zero, and in a fresh
 * checkout.
 */
export async function resolveStageLogs(options: StageOptions): Promise<StageLogs> {
  if (!options.stage && !options.cluster) {
    throw new CliError('Pass --stage <stage> (or --cluster <name or ARN>).', 2);
  }

  const region = resolveAppRegion(options.region);
  const ecs = new ECSClient({ region });
  const logs = new CloudWatchLogsClient({ region });
  const cluster = await findCluster(ecs, options.stage ?? '', options.cluster);
  const clusterName = clusterNameFromArn(cluster.clusterArn);
  const component = cluster.component ?? singleComponent();
  const groups = await discoverLogGroups(logs, clusterName, component);

  if (groups.sources.length === 0) {
    info(`No log groups under /sst/cluster/${clusterName}/ in ${region}.`);
  }

  return { region, clusterArn: cluster.clusterArn, clusterName, component, ecs, logs, ...groups };
}

function singleComponent(): string | undefined {
  const configPath = findSstConfig();
  const components = configPath ? extractLaravelComponents(configPath) : [];
  return components.length === 1 ? components[0] : undefined;
}
