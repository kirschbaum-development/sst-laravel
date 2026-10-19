<?php

namespace Kirschbaum\SST\Console\Commands;

class QueueStatusCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:queue:status';

    protected $description = 'Report failed jobs, queue sizes, and when each scheduled task last ran';

    protected function subcommand(): string
    {
        return 'queue:status';
    }
}
