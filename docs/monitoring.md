# Monitoring

Check a deployed stage from a script or a scheduled agent: what went wrong in a window, without a shell in a container and without a person at the keyboard. The commands are read-only and never prompt. They read CloudWatch and ECS directly, so they work when the app is crash-looping or scaled to zero, and from a fresh checkout: all they need is AWS credentials, `sst.config.ts`, and the stage name.

## A daily check

```bash
npx sst-laravel status --stage production --since 24h --json
npx sst-laravel logs:errors --stage production --since 24h --json
```

For exact windows, pass `--start` and `--end` instead of `--since`. Times are ISO 8601, read as UTC unless they have an offset, and the end is exclusive, so consecutive days never overlap:

```bash
npx sst-laravel logs:errors --stage production --start 2026-10-18 --end 2026-10-19 --json
```

The two checks share their exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | Nothing needs attention. |
| `1` | Something needs attention: the `attention` list of the JSON (or the `Needs attention:` lines) says what. For `logs:errors`, any error in the window. |
| `2` | The check could not run: a usage error, missing permissions, or AWS errors. |

With `--json`, stdout holds one JSON document and nothing else. Progress and diagnostics go to stderr.

## What each command reports

**`status --since <window>`** adds a report of the window to the deployment check (service revisions, ECR images, and `/up`):

- each deploy (ECS service deployment) that started in the window, its revision, and whether it completed or was rolled back;
- every task that stopped, why (`replaced` in a deploy or scale-in, `completed`, `stopped` on request, `crashed`, `health-check`, `failed-to-start`, or `infrastructure`), its stop reason, and the exit code of each container. That includes standalone tasks in the cluster, such as task runners;
- the background processes (Horizon, the scheduler, custom tasks) that exited with an error, with their exit codes, including the ones s6 restarted in place, which ECS never sees;
- the ECS service events, without the routine "reached a steady state";
- the CloudWatch alarms on the cluster, its services, target groups, or load balancers, plus any whose name starts with `--alarm-prefix`. An alarm that only drives auto scaling, such as the `AlarmLow` of target tracking, which is in `ALARM` whenever the load is low, is listed but never needs attention.

It needs attention for a rolled-back or stopped deploy, a service running fewer tasks than it wants, a task that crashed, failed a health check, or failed to start, a process that exited with an error, and an alarm in `ALARM`. A process that exits 0 and restarts, or a task replaced in a deploy, is expected. A window with more than 20,000 ECS events, or more than 5,000 process exits with an error in a log group, needs attention too: the report says up to when it read them, and how to continue: `--start` for the process exits, and for the ECS events the same window with `--ecs-events-from`, since a task can be logged after the point where the events stopped though it stopped before.

Without deployment outputs on the machine (`.sst/outputs.json`), it finds the stage's cluster by name and says that the expected revisions were not verified.

**`logs:errors`** groups the error lines of the window with CloudWatch Logs Insights and lists each group with its count, first and last time, level, latest message, and the service and task of the latest one. An error with an exception is grouped by its class and the file that threw it. One without an exception is grouped by its message. It reads JSON Laravel logs, text Laravel logs, and PHP fatal errors.

**`logs`** prints the lines of the window, oldest first, from every log group of the stage, or only those of `web`, `reverb`, `worker`, a worker name, or another task in the cluster. With `--json`, each line is a JSON object with `timestamp`, `service`, `task` (the ECS task ID), `level`, `message`, and `json` (the parsed message, when it is JSON). It stops after `--limit` lines of a log group and says where to continue with `--start`. It follows new lines by default only in a terminal, or anywhere with `--follow`, and prints the lines CloudWatch shows late, up to a minute after their time.

See [CLI](cli.md) for every option.

## What makes it work

### JSON logs

Each stack trace line of a text log arrives in CloudWatch as an event of its own. SST Laravel sets Laravel's `LOG_STDERR_FORMATTER` to a JSON formatter, unless your environment sets it, so each log entry is one line, and Logs Insights can read its fields. It is Monolog's JSON formatter, which leaves the stack trace out. Set `config.logFormat: "text"` to keep Laravel's text lines. See [`config.logFormat`](api.md).

### The ECS events

ECS lists a stopped task for about an hour. To report a day of restarts and crashes, the component records the cluster's ECS events in CloudWatch Logs: tasks that stopped, deployments, and service actions. EventBridge sends them to a small Lambda function that logs them to `/sst/cluster/<cluster>/sst-laravel/ecs-events`, kept 30 days. It logs only what `status` reads (the task, its stop code and reason, and the exit code of each container), never what a task was started with: the overrides of a task runner can hold secrets. It runs once per event and costs next to nothing. Set [`ecsEvents: false`](api.md) to leave it out; `status --since` then falls back to what ECS still lists.

A cluster that `LaravelService` didn't create, such as an `sst.aws.Cluster` for task runners, gets the same recorder with `EcsEventRecorder`. Check it with `status --cluster <cluster name> --since 24h`:

```ts
import { EcsEventRecorder } from '@kirschbaum-development/sst-laravel';

const tasks = new sst.aws.Cluster('Tasks', { vpc });
new EcsEventRecorder('TasksEvents', { cluster: tasks });
```

### Process exits

When a background process exits, its s6 `finish` script logs a JSON line before s6 restarts it or the container stops.

### The scheduler

`scheduler: true` runs `php artisan schedule:run` at the start of every minute, like `schedule:work`. `schedule:work` itself writes the output and errors of the tasks together, so a line a task logs ends up after the task's "Running" line and isn't JSON any more. Run the scheduler with `scheduler: true` rather than as a `schedule:work` task.

## The events

Each event is one JSON line in the container's log, with `sst_laravel` naming it.

| `sst_laravel` | Fields |
| --- | --- |
| `process_exit` | `process`, `exit_code` (128 + the signal when a signal killed it), `action` (`restart` or `stop_container`), `message` |

To read them yourself, filter on the field: `npx sst-laravel logs --stage production --no-follow --since 24h --filter '{ $.sst_laravel = "process_exit" }'`.

## Permissions

A role for monitoring only needs to read. This policy covers every command on this page:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:ListClusters",
        "ecs:ListServices",
        "ecs:DescribeServices",
        "ecs:ListTasks",
        "ecs:DescribeTasks",
        "ecs:ListServiceDeployments",
        "ecs:DescribeServiceRevisions",
        "ecs:DescribeTaskDefinition",
        "ecr:DescribeImages",
        "logs:DescribeLogGroups",
        "logs:FilterLogEvents",
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:StopQuery",
        "cloudwatch:DescribeAlarms",
        "elasticloadbalancing:DescribeTargetGroups"
      ],
      "Resource": "*"
    }
  ]
}
```

It leaves out the environment bucket and Secrets Manager, where SST Laravel keeps the app's variables. That doesn't keep every secret from the role:

- `ecs:DescribeTasks` returns the overrides each task was started with, such as the command and environment of a task runner;
- `ecs:DescribeTaskDefinition` returns the environment values written into a task definition (SST Laravel puts the app's variables in the environment file, but a `transform` can add some);
- the log groups hold whatever the app logs.

When the role must not see the ECS data, give it only the log groups. That covers `logs` and `logs:errors`, but not `status`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:ListClusters",
        "logs:DescribeLogGroups",
        "logs:FilterLogEvents",
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:StopQuery"
      ],
      "Resource": "*"
    }
  ]
}
```

The recorded ECS events leave the overrides out (see [The ECS events](#the-ecs-events)), so this role can read them in the log groups too.

## Limits

- Logs Insights charges for the data it scans ($0.005 per GB in us-east-1). `logs:errors` runs one query over the window you pass.
- Logs Insights reads up to 50 log groups at once. Name a service to narrow a larger cluster.
- The ECS events start with the first deploy of a version that has them.
- A task is reported in the window it stopped in. Its event reaches the log group a moment later, so `status --since` reads the events 15 minutes around the window: a task that stops at the end of a window shows up in it once the event is in, at most 15 minutes late.
- Errors without an exception are grouped by their message, so messages with IDs in them make a group each.
