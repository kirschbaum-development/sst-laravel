<?php

namespace Kirschbaum\SST;

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
use Kirschbaum\SST\Console\Commands\SkillInstallCommand;
use Kirschbaum\SST\Console\Commands\SshCommand;
use Kirschbaum\SST\Console\Commands\StatusCommand;

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
