# Monitoring

Check a deployed stage from a script or a scheduled agent: what went wrong in a window, without a shell in a container and without a person at the keyboard. The commands are read-only and never prompt. They read CloudWatch and ECS directly, so they work when the app is crash-looping or scaled to zero, and from a fresh checkout: all they need is AWS credentials, `sst.config.ts`, and the stage name.

## A daily check

```bash
npx sst-laravel status --stage production --since 24h --json
npx sst-laravel logs:errors --stage production --since 24h --json
npx sst-laravel queue:status --stage production --since 24h --json
```

For exact windows, pass `--start` and `--end` instead of `--since`. Times are ISO 8601, read as UTC unless they have an offset, and the end is exclusive, so consecutive days never overlap:

```bash
npx sst-laravel logs:errors --stage production --start 2026-10-18 --end 2026-10-19 --json
```

The three checks share their exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | Nothing needs attention. |
| `1` | Something needs attention: the `attention` list of the JSON (or the `Needs attention:` lines) says what. For `logs:errors`, any error in the window. |
| `2` | The check could not run: a usage error, missing permissions, or AWS errors. For `queue:status`, also a window without any of the Laravel package's events. |

With `--json`, stdout holds one JSON document and nothing else. Progress and diagnostics go to stderr.

## What each command reports

**`status --since <window>`** adds a report of the window to the deployment check (service revisions, ECR images, and `/up`):

- each deploy (ECS service deployment) that started in the window, its revision, and whether it completed or was rolled back;
- every task that stopped, why (`replaced` in a deploy or scale-in, `completed`, `stopped` on request, `crashed`, `health-check`, `failed-to-start`, or `infrastructure`), its stop reason, and the exit code of each container. That includes standalone tasks in the cluster, such as task runners;
- the background processes (Horizon, the scheduler, custom tasks) that exited with an error, with their exit codes, including the ones s6 restarted in place, which ECS never sees;
- the ECS service events, without the routine "reached a steady state";
- the CloudWatch alarms on the cluster, its services, target groups, or load balancers, plus any whose name starts with `--alarm-prefix`.

It needs attention for a rolled-back or stopped deploy, a service running fewer tasks than it wants, a task that crashed, failed a health check, or failed to start, a process that exited with an error, and an alarm in `ALARM`. A process that exits 0 and restarts, or a task replaced in a deploy, is expected. A window with more than 20,000 ECS events, or more than 5,000 process exits with an error in a log group, needs attention too: the report says up to when it read them, and how to continue: `--start` for the process exits, and for the ECS events the same window with `--ecs-events-from`, since a task can be logged after the point where the events stopped though it stopped before.

Without deployment outputs on the machine (`.sst/outputs.json`), it finds the stage's cluster by name and says that the expected revisions were not verified.

**`logs:errors`** groups the error lines of the window with CloudWatch Logs Insights and lists each group with its count, first and last time, level, latest message, and the service and task of the latest one. An error with an exception is grouped by its class and file; one without, by its message. It reads JSON Laravel logs, text Laravel logs, and PHP fatal errors.

**`queue:status`** reports, from the events the Laravel package logs (see below):

- each job that failed in the window, with its count, connection, queue, and latest exception;
- the size of each queue, sampled every minute, and its largest size in the window, plus the size of the `failed_jobs` table;
- each scheduled task: how many times it ran, failed (threw, or exited with an error), and was skipped, when it last finished, its exit code, and whether its last run failed.

It needs attention for failed jobs, a scheduled task whose last run failed, a queue whose size can't be read or is above `--max-size`, and a queue the scheduler stopped sampling (none in the last 10 minutes of the window, or none at all). Without any event in the window, it exits `2`: the package may be missing, or the scheduler down. Pass `--no-samples` when the app runs no scheduler, so it takes no samples.

**`logs`** prints the lines of the window, oldest first, from every log group of the stage, or only those of `web`, `reverb`, `worker`, a worker name, or another task in the cluster. With `--json`, each line is a JSON object with `timestamp`, `service`, `task` (the ECS task ID), `revision` (the deploy, with the package's formatter), `level`, `message`, and `json` (the parsed message, when it is JSON). It stops after `--limit` lines of a log group and says where to continue with `--start`. It follows new lines by default only in a terminal, or anywhere with `--follow`, and prints the lines CloudWatch shows late, up to a minute after their time.

See [CLI](cli.md) for every option.

## What makes it work

### JSON logs

Each stack trace line of a text log arrives in CloudWatch as an event of its own. SST Laravel sets Laravel's `LOG_STDERR_FORMATTER` to a JSON formatter, unless your environment sets it, so each log entry is one line, and Logs Insights can read its fields. Set `config.logFormat: "text"` to keep Laravel's text lines. See [`config.logFormat`](api.md).

### The Laravel package

Install the package's Composer package in the app as well:

```bash
composer require kirschbaum-development/sst-laravel
```

The images copy `vendor/` as it is, so install it before the deploy (not as a dev dependency if you deploy with `--no-dev`). In the containers SST Laravel deploys, and nowhere else, it:

- formats the JSON log lines with the stack trace, and adds the service, ECS task, and deploy (task definition revision) to each line's `extra`. An entry stays under 16 KB, the most Fargate keeps in one log event: a longer one first loses the end of its stack traces (it says how many frames it left out), then the end of its longest strings and message. Without the package, Monolog's JSON formatter is used, which leaves the trace out;
- logs a line for each failed job and for each scheduled task that finished, failed, or was skipped;
- samples the queue sizes and the `failed_jobs` table every minute from the scheduler, when one runs (`scheduler: true` on web or a worker).

The samples cover the default queue and, with Horizon, the queues of its supervisors for the app's environment. To pick them yourself, set `SST_LARAVEL_QUEUES` to a comma-separated list of `connection:queue` (or queues of the default connection). `SST_LARAVEL_MONITORING=false` turns the events and samples off, and `SST_LARAVEL_SAMPLE_QUEUES=false` only the samples.

### The ECS events

ECS lists a stopped task for about an hour. To report a day of restarts and crashes, the component records the cluster's ECS events in CloudWatch Logs: tasks that stopped, deployments, and service actions. EventBridge sends them to a small Lambda function that logs them to `/sst/cluster/<cluster>/sst-laravel/ecs-events`, kept 30 days. It logs only what `status` reads (the task, its stop code and reason, and the exit code of each container), never what a task was started with: the overrides of a task runner can hold secrets. It runs once per event and costs next to nothing. Set [`ecsEvents: false`](api.md) to leave it out; `status --since` then falls back to what ECS still lists.

### Process exits

When a background process exits, its s6 `finish` script logs a JSON line before s6 restarts it or the container stops.

### The scheduler

`scheduler: true` runs `php artisan schedule:run` at the start of every minute, like `schedule:work`. `schedule:work` itself writes the output and errors of the tasks together, so a line a task logs, and its `schedule_finished` event, end up after the task's "Running" line and aren't JSON any more. Run the scheduler with `scheduler: true` rather than as a `schedule:work` task.

## The events

Each event is one JSON line in the container's log, with `sst_laravel` naming it. The package's events also have `time`, `service`, `ecs_task`, and `revision`.

| `sst_laravel` | Fields |
| --- | --- |
| `process_exit` | `process`, `exit_code` (128 + the signal when a signal killed it), `action` (`restart` or `stop_container`), `message` |
| `job_failed` | `job`, `connection`, `queue`, `uuid`, `attempts`, `exception`, `message`, `file` |
| `schedule_finished` | `task`, `expression`, `exit_code`, `runtime` (seconds), `background` |
| `schedule_failed` | `task`, `expression`, `exception`, `message`, `file` |
| `schedule_skipped` | `task`, `expression` |
| `queue_size` | `connection`, `queue`, `size`, or `error` |
| `failed_jobs_total` | `failed_jobs` |

`task` names a scheduled command the way `php artisan schedule:list` does (`php artisan reports:daily`), or a callback by its description.

To read them yourself, filter on the field: `npx sst-laravel logs --stage production --no-follow --since 24h --filter '{ $.sst_laravel = "job_failed" }'`.

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

When the role must not see the ECS data, give it only the log groups. That covers `logs`, `logs:errors`, and `queue:status`, but not `status`:

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

- Logs Insights charges for the data it scans ($0.005 per GB in us-east-1). `logs:errors` runs one query and `queue:status` six, over the window you pass.
- Logs Insights reads up to 50 log groups at once. Name a service to narrow a larger cluster.
- The ECS events and the package's events start with the first deploy of a version that has them.
- A task is reported in the window it stopped in. Its event reaches the log group a moment later, so `status --since` reads the events 15 minutes around the window: a task that stops at the end of a window shows up in it once the event is in, at most 15 minutes late.
- Errors without an exception are grouped by their message, so messages with IDs in them make a group each.
