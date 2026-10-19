<?php

namespace Kirschbaum\SST\Monitoring;

use Illuminate\Console\Application as ConsoleApplication;
use Illuminate\Console\Events\ScheduledBackgroundTaskFinished;
use Illuminate\Console\Events\ScheduledTaskFailed;
use Illuminate\Console\Events\ScheduledTaskFinished;
use Illuminate\Console\Events\ScheduledTaskSkipped;
use Illuminate\Console\Events\ScheduledTaskStarting;
use Illuminate\Console\Scheduling\CallbackEvent;
use Illuminate\Console\Scheduling\Event as ScheduledTask;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Queue\Events\JobFailed;
use Throwable;

/**
 * Logs failed jobs and every scheduled task that finished, failed, or was
 * skipped, as `Events` lines, so the queue and the schedule can be checked
 * from CloudWatch without a shell in the container.
 */
final class MonitoringSubscriber
{
    /**
     * The tasks whose last run finished with a non-zero exit code. Laravel 12
     * then also reports the run as failed; one event per run is enough.
     *
     * @var array<int, true>
     */
    private array $exitedWithError = [];

    public function subscribe(Dispatcher $events): void
    {
        $events->listen(JobFailed::class, [$this, 'jobFailed']);
        $events->listen(ScheduledTaskStarting::class, [$this, 'scheduledTaskStarting']);
        $events->listen(ScheduledTaskFinished::class, [$this, 'scheduledTaskFinished']);
        $events->listen(ScheduledBackgroundTaskFinished::class, [$this, 'scheduledBackgroundTaskFinished']);
        $events->listen(ScheduledTaskFailed::class, [$this, 'scheduledTaskFailed']);
        $events->listen(ScheduledTaskSkipped::class, [$this, 'scheduledTaskSkipped']);
    }

    public function jobFailed(JobFailed $event): void
    {
        $this->safely(function () use ($event) {
            $job = $event->job;

            Events::emit('job_failed', [
                'job' => $job->resolveName(),
                'connection' => $event->connectionName,
                'queue' => $job->getQueue(),
                'uuid' => method_exists($job, 'uuid') ? $job->uuid() : null,
                'attempts' => $job->attempts(),
            ] + Events::exception($event->exception));
        });
    }

    public function scheduledTaskStarting(ScheduledTaskStarting $event): void
    {
        // Laravel 10 and 11 report a non-zero exit only as finished: forget it before the next run.
        unset($this->exitedWithError[spl_object_id($event->task)]);
    }

    public function scheduledTaskFinished(ScheduledTaskFinished $event): void
    {
        // A background task finishes later: ScheduledBackgroundTaskFinished has its exit code.
        if ($event->task->runInBackground || $this->isOwnTask($event->task)) {
            return;
        }

        if ((int) $event->task->exitCode !== 0) {
            $this->exitedWithError[spl_object_id($event->task)] = true;
        }

        $this->safely(fn () => Events::emit('schedule_finished', $this->task($event->task) + [
            'exit_code' => $event->task->exitCode,
            'runtime' => $event->runtime,
        ]));
    }

    public function scheduledBackgroundTaskFinished(ScheduledBackgroundTaskFinished $event): void
    {
        $this->safely(fn () => Events::emit('schedule_finished', $this->task($event->task) + [
            'exit_code' => $event->task->exitCode,
            'background' => true,
        ]));
    }

    public function scheduledTaskFailed(ScheduledTaskFailed $event): void
    {
        $id = spl_object_id($event->task);

        // Its schedule_finished line has the exit code already.
        if (isset($this->exitedWithError[$id])) {
            unset($this->exitedWithError[$id]);

            return;
        }

        if ($this->isOwnTask($event->task)) {
            return;
        }

        $this->safely(fn () => Events::emit('schedule_failed', $this->task($event->task) + Events::exception($event->exception)));
    }

    public function scheduledTaskSkipped(ScheduledTaskSkipped $event): void
    {
        if ($this->isOwnTask($event->task)) {
            return;
        }

        $this->safely(fn () => Events::emit('schedule_skipped', $this->task($event->task)));
    }

    /**
     * The task as `schedule:list` names it: the command with `php artisan`
     * instead of the binaries' paths, or a callback's description.
     *
     * @return array{task: string, expression: string}
     */
    private function task(ScheduledTask $task): array
    {
        if ($task instanceof CallbackEvent) {
            $name = $task->getSummaryForDisplay();
        } else {
            $name = str_replace(
                [ConsoleApplication::phpBinary(), ConsoleApplication::artisanBinary()],
                ['php', 'artisan'],
                (string) $task->command,
            );
        }

        return ['task' => trim($name) ?: 'unknown', 'expression' => $task->expression];
    }

    private function isOwnTask(ScheduledTask $task): bool
    {
        return $task instanceof CallbackEvent && $task->description === SampleQueues::NAME;
    }

    private function safely(callable $callback): void
    {
        try {
            $callback();
        } catch (Throwable) {
            // Monitoring never breaks a job or the schedule.
        }
    }
}
