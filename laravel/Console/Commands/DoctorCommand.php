<?php

namespace Kirschbaum\SST\Console\Commands;

class DoctorCommand extends SstLaravelCommand
{
    protected $signature = 'sst-laravel:doctor';

    protected $description = 'Check that this machine and Laravel app are ready to deploy with SST Laravel';

    protected function subcommand(): string
    {
        return 'doctor';
    }
}
