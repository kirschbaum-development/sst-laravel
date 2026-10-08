<?php

namespace Kirschbaum\SST\Console\Commands;

class SkillInstallCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:skill:install';

    protected $description = 'Install or update the SST Laravel agent skill';

    protected function subcommand(): string
    {
        return 'skill:install';
    }
}
