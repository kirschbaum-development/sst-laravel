<?php

namespace Kirschbaum\SST\Console\Commands;

class LogsCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:logs';

    protected $description = 'Print or stream the CloudWatch logs of the stage';

    protected function subcommand(): string
    {
        return 'logs';
    }
}
