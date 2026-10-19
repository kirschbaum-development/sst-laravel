<?php

namespace Kirschbaum\SST\Console\Commands;

class StatusCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:status';

    protected $description = 'Check a deployment and, with --since, report the health of a window';

    protected function subcommand(): string
    {
        return 'status';
    }
}
