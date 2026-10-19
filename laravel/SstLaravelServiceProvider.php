<?php

namespace Kirschbaum\SST;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\ServiceProvider;
use Kirschbaum\SST\Console\Commands\CommandRunCommand;
use Kirschbaum\SST\Console\Commands\DeployCommand;
use Kirschbaum\SST\Console\Commands\DoctorCommand;
use Kirschbaum\SST\Console\Commands\EnvPullCommand;
use Kirschbaum\SST\Console\Commands\EnvPushCommand;
use Kirschbaum\SST\Console\Commands\GithubIamCommand;
use Kirschbaum\SST\Console\Commands\GuideCommand;
use Kirschbaum\SST\Console\Commands\InitCommand;
use Kirschbaum\SST\Console\Commands\InstallCommand;
use Kirschbaum\SST\Console\Commands\LogsCommand;
use Kirschbaum\SST\Console\Commands\LogsErrorsCommand;
use Kirschbaum\SST\Console\Commands\QueueStatusCommand;
use Kirschbaum\SST\Console\Commands\SkillInstallCommand;
use Kirschbaum\SST\Console\Commands\SshCommand;
use Kirschbaum\SST\Console\Commands\StatusCommand;
use Kirschbaum\SST\Monitoring\MonitoringSubscriber;
use Kirschbaum\SST\Monitoring\SampleQueues;
use Kirschbaum\SST\Monitoring\TaskContext;

/**
 * @property \Illuminate\Contracts\Foundation\Application $app
 */
class SstLaravelServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom($this->configFile(), 'sst-laravel');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([
                $this->configFile() => $this->publishedConfigPath(),
            ], 'sst-laravel-config');

            $this->commands([
                InitCommand::class,
                DeployCommand::class,
                CommandRunCommand::class,
                SshCommand::class,
                LogsCommand::class,
                LogsErrorsCommand::class,
                QueueStatusCommand::class,
                GithubIamCommand::class,
                InstallCommand::class,
                EnvPullCommand::class,
                EnvPushCommand::class,
                StatusCommand::class,
                DoctorCommand::class,
                GuideCommand::class,
                SkillInstallCommand::class,
            ]);
        }

        $this->bootMonitoring();
    }

    /**
     * In the containers SST Laravel deploys, logs failed jobs and scheduled
     * task runs, and samples the queues every minute, for
     * `sst-laravel queue:status`. Nothing happens anywhere else.
     */
    protected function bootMonitoring(): void
    {
        if (! TaskContext::inContainer() || ! $this->app['config']->get('sst-laravel.monitoring.enabled', true)) {
            return;
        }

        $this->app['events']->subscribe(MonitoringSubscriber::class);

        if ($this->app['config']->get('sst-laravel.monitoring.sample_queues', true)) {
            $this->callAfterResolving(Schedule::class, function (Schedule $schedule): void {
                $schedule->call(new SampleQueues($this->app))->everyMinute()->name(SampleQueues::NAME);
            });
        }
    }

    protected function configFile(): string
    {
        return __DIR__ . '/../config/sst-laravel.php';
    }

    protected function publishedConfigPath(): string
    {
        if (function_exists('config_path')) {
            return \config_path('sst-laravel.php');
        }

        return $this->app->basePath('config/sst-laravel.php');
    }
}
