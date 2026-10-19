import { ComponentResourceOptions, Input, output, Output } from '@pulumi/pulumi';
import { Component } from './sst-platform';
import { createEcsEventRecorder } from './ecs-events';

/** A cluster: an `sst.aws.Cluster`, or an `aws.ecs.Cluster` such as its `nodes.cluster`. */
export type EcsEventRecorderCluster = { arn: Input<string>; name: Input<string> } | { nodes: { cluster: { arn: Input<string>; name: Input<string> } } };

export interface EcsEventRecorderArgs {
  /** The cluster whose ECS events to record. */
  cluster: EcsEventRecorderCluster;
}

/**
 * Records the ECS events of a cluster that `LaravelService` didn't create,
 * such as an `sst.aws.Cluster` for task runners, the way `ecsEvents` does
 * for its own: `sst-laravel status --cluster <name> --since 24h` then reports
 * the tasks of that cluster that stopped, with their exit codes.
 *
 * @example
 * ```ts
 * const tasks = new sst.aws.Cluster('Tasks', { vpc });
 * new EcsEventRecorder('TasksEvents', { cluster: tasks });
 * ```
 */
export class EcsEventRecorder extends Component {
  private readonly _logGroupName: Output<string>;

  constructor(name: string, args: EcsEventRecorderArgs, opts: ComponentResourceOptions = {}) {
    super(__pulumiType, name, args, opts);

    const cluster = 'nodes' in args.cluster ? args.cluster.nodes.cluster : args.cluster;
    const recorder = createEcsEventRecorder(this, name, { arn: output(cluster.arn), name: output(cluster.name) });
    this._logGroupName = recorder.logGroupName;

    this.registerOutputs({ logGroupName: this._logGroupName });
  }

  /** The log group of the recorded events, `/sst/cluster/<cluster>/sst-laravel/ecs-events`. */
  public get logGroupName(): Output<string> {
    return this._logGroupName;
  }
}

const __pulumiType = 'sst:aws:EcsEventRecorder';
// @ts-expect-error
EcsEventRecorder.__pulumiType = __pulumiType;
