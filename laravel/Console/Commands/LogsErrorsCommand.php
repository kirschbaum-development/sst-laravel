<?php

namespace Kirschbaum\SST\Console\Commands;

class LogsErrorsCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:logs:errors';

    protected $description = 'Summarise the errors of a window, grouped, with counts and first and last seen';

    protected function subcommand(): string
    {
        return 'logs:errors';
    }
}
