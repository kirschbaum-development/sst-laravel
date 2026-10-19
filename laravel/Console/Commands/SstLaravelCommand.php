<?php

namespace Kirschbaum\SST\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Contracts\Foundation\Application;
use Symfony\Component\Console\Output\ConsoleOutputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Process\Process;

/**
 * @property Application $laravel
 * @property string|null $name
 * @property string|null $signature
 */
abstract class SstLaravelCommand extends Command
{
    /**
     * Allow all CLI arguments through so we can forward them to the Node CLI unchanged.
     */
    protected bool $ignoreValidationErrors = true;

    /**
     * Return the subcommand that should be executed by the Node CLI.
     */
    abstract protected function subcommand(): string;

    public function handle(): int
    {
        $arguments = array_merge(
            $this->resolveBinary(),
            [$this->subcommand()],
            $this->forwardedArguments()
        );

        $process = new Process($arguments, $this->laravelBasePath(), $this->processEnvironment());
        $process->setTimeout(null);

        $this->configureTty($process);

        // Diagnostics stay on stderr, so `--json` output on stdout parses as is.
        $output = $this->output->getOutput();
        $errorOutput = $output instanceof ConsoleOutputInterface ? $output->getErrorOutput() : $output;

        $exitCode = $process->run(function (string $type, string $buffer) use ($output, $errorOutput): void {
            ($type === Process::ERR ? $errorOutput : $output)->write($buffer, false, OutputInterface::OUTPUT_RAW);
        });

        return $exitCode;
    }

    /**
     * Build the environment variables that should be forwarded to the child process.
     */
    protected function processEnvironment(): array
    {
        return array_merge($_ENV ?? [], $_SERVER ?? []);
    }

    /**
     * Attempt to attach STDIN/STDOUT directly to the child process when supported.
     */
    protected function configureTty(Process $process): void
    {
        if (!Process::isTtySupported() || !$this->input->isInteractive()) {
            return;
        }

        try {
            $process->setTty(true);
        } catch (\Throwable $exception) {
            // Fallback to streaming output via the callback when TTY is not available.
        }
    }

    /**
     * Determine which executable should be used to run the SST Laravel CLI.
     */
    protected function resolveBinary(): array
    {
        if ($configured = $this->configuredBinary()) {
            return [$configured];
        }

        if ($localBinary = $this->localBinaryPath()) {
            return [$localBinary];
        }

        return ['npx', '--yes', '@kirschbaum-development/sst-laravel'];
    }

    /**
     * Check for a binary defined via config or environment variables.
     */
    protected function configuredBinary(): ?string
    {
        $fromConfig = null;

        if (($app = $this->laravelApplication()) && $app->bound('config')) {
            $fromConfig = $app['config']->get('sst-laravel.binary');
        }

        $fromEnv = $_ENV['SST_LARAVEL_BINARY'] ?? $_SERVER['SST_LARAVEL_BINARY'] ?? null;

        return $fromConfig ?: $fromEnv;
    }

    /**
     * Look for a locally installed CLI inside node_modules/.bin.
     */
    protected function localBinaryPath(): ?string
    {
        $suffix = DIRECTORY_SEPARATOR === '\\' ? '.cmd' : '';
        $path = $this->laravelBasePath('node_modules/.bin/sst-laravel' . $suffix);

        return is_file($path) ? $path : null;
    }

    /**
     * Collect every argument the developer passed after the Artisan command name.
     */
    protected function forwardedArguments(): array
    {
        $argv = $_SERVER['argv'] ?? [];
        $commandName = $this->commandName();

        if ($commandName === null) {
            return [];
        }

        $index = array_search($commandName, $argv, true);

        if ($index === false) {
            return [];
        }

        return array_slice($argv, $index + 1);
    }

    protected function commandName(): ?string
    {
        if (property_exists($this, 'name') && $this->name) {
            return $this->name;
        }

        if (property_exists($this, 'signature') && $this->signature) {
            return trim(strtok($this->signature, ' '));
        }

        return null;
    }

    protected function laravelBasePath(string $path = ''): string
    {
        $app = $this->laravelApplication();

        if ($app) {
            return $path === '' ? $app->basePath() : $app->basePath($path);
        }

        $base = getcwd() ?: __DIR__;

        return $path === '' ? $base : rtrim($base, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . ltrim($path, DIRECTORY_SEPARATOR);
    }

    protected function laravelApplication(): ?Application
    {
        if (method_exists($this, 'getLaravel')) {
            return $this->getLaravel();
        }

        return null;
    }
}
