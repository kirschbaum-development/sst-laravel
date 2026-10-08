<?php

namespace Kirschbaum\SST\Console\Commands;

class GuideCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:guide';

    protected $description = 'Print the step-by-step deploy guide for AI agents (use --reference for the short config reference)';

    protected function subcommand(): string
    {
        return 'guide';
    }
}
