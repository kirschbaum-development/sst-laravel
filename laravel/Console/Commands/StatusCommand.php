<?php

namespace Kirschbaum\SST\Console\Commands;

class StatusCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:status';

    protected $description = 'Check a deployment: running tasks plus an optional /up health check';

    protected function subcommand(): string
    {
        return 'status';
    }
}
