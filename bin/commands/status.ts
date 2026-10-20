import { Command } from 'commander';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient } from '@aws-sdk/client-ecs';
import { APP_REGION_OPTION_HELP } from '../utils/aws.js';
import { resolveAppRegion } from '../utils/sst-config.js';
import { readOutputs, readSavedAppUrl } from '../utils/app-url.js';
import { DeploymentTargets, readStatusDeploymentTargets, savedDeploymentStages } from '../utils/deployment-targets.js';
import { DEFAULT_WAIT_SECONDS, isLoadBalancerHttpsUrl, RETRY_SECONDS, verifyDeployment } from '../utils/deployment-check.js';
import { CliError, EXIT_ATTENTION, EXIT_ERROR, EXIT_OK, exitAfterOutput, exitWithError, info, printJson } from '../utils/cli.js';
import { findCluster } from '../utils/ecs.js';
import { buildHistoryReport, formatHistoryReport, HistoryReport } from '../utils/history-report.js';
import { clusterNameFromArn, discoverLogGroups } from '../utils/log-sources.js';
import { parseTime, resolveTimeWindow } from '../utils/time.js';

export { isLoadBalancerHttpsUrl };

interface StatusOptions {
  stage?: string;
  cluster?: string;
  region?: string;
  url?: string;
  path: string;
  wait?: string | boolean;
  since?: string;
  start?: string;
  end?: string;
  alarmPrefix?: string[];
  ecsEventsFrom?: string;
  json?: boolean;
}

export const parseWaitSeconds = (wait: string | boolean | undefined): number => {
  if (wait === undefined || wait === false) {
    return 0;
  }

  if (wait === true) {
    return DEFAULT_WAIT_SECONDS;
  }

  const seconds = parseInt(wait, 10);
  return Number.isNaN(seconds) || seconds <= 0 ? DEFAULT_WAIT_SECONDS : seconds;
};

/**
 * The expected deployment of the stage, from the SST outputs or the targets
 * `deploy` saved. Undefined only when this machine has neither (a fresh
 * checkout): then the stage's cluster is found by name and checked without
 * expected revisions. Outputs that exist but are wrong still fail.
 */
export function readStageTargets(cwd: string, outputs: Record<string, unknown>, stage: string): DeploymentTargets | undefined {
  if (outputs.deployment === undefined && !savedDeploymentStages(cwd).includes(stage)) {
    return undefined;
  }

  return readStatusDeploymentTargets(cwd, outputs, stage);
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export const statusCommand = new Command('status')
  .description('Check the stage: registered service revisions, ECR images, and /up. With --since, also a read-only health report of the window: deploys, stopped tasks and exit codes, process restarts, service events, and alarms.')
  .option('-s, --stage <stage>', 'SST stage name (required unless --cluster is given)')
  .option('-c, --cluster <cluster>', 'Restrict to this cluster; without --stage, check ECS history only')
  .option('-r, --region <region>', APP_REGION_OPTION_HELP)
  .option('-u, --url <url>', 'Public app URL to health-check (default: the URL the last `sst-laravel deploy` of the stage saved)')
  .option('-p, --path <path>', 'Health path to request', '/up')
  .option('-w, --wait [seconds]', `Keep checking every ${RETRY_SECONDS}s while ECS rolls out, up to this many seconds (default ${DEFAULT_WAIT_SECONDS}). Use it right after a deploy.`)
  .option('--since <duration>', 'Add the health report of this window, e.g. 24h or 7d')
  .option('--start <time>', 'Start of the report window: an ISO 8601 time (UTC unless it has an offset) or a duration ago')
  .option('--end <time>', 'End of the report window, exclusive (default: now)')
  .option('--alarm-prefix <prefix>', 'Also report the CloudWatch alarms whose name starts with this (repeatable)', collect)
  .option('--ecs-events-from <time>', 'Resume the recorded ECS events of the same window where a report with too many of them stopped (its truncated.ecsEvents)')
  .option('--json', 'Print one JSON document instead of text')
  .action(async (options: StatusOptions) => {
    try {
      if (!options.stage && !options.cluster) {
        throw new CliError('Pass --stage <stage> or --cluster <arn>.', EXIT_ERROR);
      }

      const history = Boolean(options.since || options.start || options.end);
      const window = history ? resolveTimeWindow(options, '24h') : undefined;
      const ecsEventsFrom = options.ecsEventsFrom === undefined ? undefined : parseTime(options.ecsEventsFrom, Date.now());

      if (ecsEventsFrom !== undefined && !window) {
        throw new CliError('--ecs-events-from resumes a report: pass its window with --start and --end too.', EXIT_ERROR);
      }
      const log = options.json ? info : (line: string) => console.log(line);
      const region = resolveAppRegion(options.region);
      const ecsClient = new ECSClient({ region });

      const outputs = readOutputs(process.cwd());
      // outputs.json is overwritten by another stage's deploy. Saved targets
      // keep status tied to the intended revision of the requested stage.
      const stageTargets = options.stage ? readStageTargets(process.cwd(), outputs, options.stage) : undefined;
      const clusterOption = options.cluster;
      // --cluster takes a name or an ARN; the outputs hold ARNs.
      if (clusterOption && stageTargets) {
        stageTargets.services = stageTargets.services.filter((target) => clusterNameFromArn(target.cluster) === clusterNameFromArn(clusterOption));
      }
      // A cluster without any of the stage's services, such as one for task
      // runners, is checked on its own.
      const otherCluster = Boolean(clusterOption && stageTargets && stageTargets.services.length === 0);
      const targets = otherCluster ? undefined : stageTargets;

      let clusterArns: string[];
      let component: string | undefined;

      if (targets) {
        clusterArns = [...new Set(targets.services.map((target) => target.cluster))];
        if (!clusterArns.length) throw new CliError('No registered services match this cluster.', EXIT_ERROR);
      } else {
        const cluster = await findCluster(ecsClient, options.stage ?? '', options.cluster, info);
        clusterArns = [cluster.clusterArn];
        component = cluster.component;
        log(otherCluster
          ? `${clusterNameFromArn(clusterOption!)} runs none of the services ${options.stage} deployed: checking it on its own, without expected revisions.`
          : options.stage
            ? `No deployment outputs for ${options.stage} on this machine: checking ${clusterOption ? clusterNameFromArn(clusterOption) : 'its cluster'} without the expected revisions and images (deploy from here, or keep .sst/outputs.json, to verify them).`
            : 'Cluster diagnostics only: pass --stage with deployment outputs to verify the expected revision and ECR images.');
      }

      // The stage's URL is served by the stage's cluster, not another one.
      if (!options.url && options.stage && !otherCluster) {
        options.url = readSavedAppUrl(process.cwd(), options.stage);

        if (options.url) {
          log(`URL: ${options.url} (saved by the last \`sst-laravel deploy\` of ${options.stage})`);
        }
      }

      if (options.url && isLoadBalancerHttpsUrl(options.url)) {
        log('Note: the load balancer address only serves http:// until you add a domain. Checking it over https:// will fail.');
      }

      log('');

      const waitSeconds = parseWaitSeconds(options.wait);
      const deployment = await verifyDeployment({
        ecsClient,
        clusterArns,
        targets,
        url: options.url,
        healthPath: options.path,
        waitSeconds,
        // A cluster named with --cluster may only run one-off tasks. The
        // cluster of a LaravelService always has services.
        requireServices: Boolean(targets || component),
        log,
      });

      const reports: Array<HistoryReport & { cluster: string }> = [];

      if (window) {
        const logs = new CloudWatchLogsClient({ region });

        for (const clusterArn of clusterArns) {
          const clusterName = clusterNameFromArn(clusterArn);
          const groups = await discoverLogGroups(logs, clusterName, component);
          const report = await buildHistoryReport({
            ecs: ecsClient,
            logs,
            region,
            clusterArn,
            clusterName,
            serviceArns: targets?.services.filter((target) => target.cluster === clusterArn).map((target) => target.service),
            sources: groups.sources,
            ecsEventsLogGroup: groups.ecsEvents,
            window,
            alarmPrefixes: options.alarmPrefix,
            ecsEventsFrom,
          });

          reports.push({ ...report, cluster: clusterName });
          log('');
          formatHistoryReport(report).forEach((line) => log(line));
        }
      }

      // Every unhealthy result says why, in the JSON as well as the text.
      const attention = [...deployment.attention, ...reports.flatMap((report) => report.attention)];
      const healthy = deployment.verdict === 'healthy' && attention.length === 0;

      if (options.json) {
        printJson({
          stage: options.stage ?? null,
          region,
          verified: Boolean(targets),
          healthy,
          deployment: {
            verdict: deployment.verdict,
            rollouts: deployment.rollouts,
            missingImages: deployment.missingImages,
            health: { state: deployment.health.state, url: options.url ?? null, path: options.path, message: deployment.health.lines.join(' ') },
          },
          ...(window ? { history: reports } : {}),
          attention,
        });
        await exitAfterOutput(healthy ? EXIT_OK : EXIT_ATTENTION);
      }

      log('');

      if (healthy) {
        if (targets) {
          log('Expected deployment is running and its ECR images are available.');
        } else if (deployment.rollouts.length === 0) {
          log(window ? 'The cluster has no services; its tasks were checked.' : 'The cluster has no services to check. Add --since 24h to check the tasks that stopped.');
        } else {
          log('Cluster looks healthy; the expected deployment was not verified.');
        }
        if (window) log('Nothing in the window needs attention.');
        return;
      }

      if (deployment.verdict === 'in-progress') {
        log('ECS is still rolling out. Run again with --wait to keep checking until it finishes.');
      } else if (deployment.verdict === 'timed-out') {
        log(`Gave up after ${waitSeconds}s: the rollout has not finished.`);
      }

      for (const line of attention) {
        log(`Needs attention: ${line}`);
      }

      const target = [
        options.stage && !otherCluster ? `--stage ${options.stage}` : `--cluster ${clusterOption}`,
        ...(options.region ? [`--region ${options.region}`] : []),
      ].join(' ');
      log(`Something needs attention. Errors: \`npx sst-laravel logs:errors ${target} --since 24h\`. Recent logs: \`npx sst-laravel logs ${target} --no-follow\`.`);
      await exitAfterOutput(EXIT_ATTENTION);
    } catch (error) {
      await exitWithError(error, EXIT_ERROR);
    }
  });
