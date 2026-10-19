/**
 * Conventions for commands that agents and scripts run unattended:
 *
 * - The data goes to stdout; progress and diagnostics go to stderr, so
 *   `--json` output parses as is.
 * - Nothing prompts or follows a stream unless both stdin and stdout are a
 *   terminal.
 * - The checks (`status`, `logs:errors`, `queue:status`) exit 0 when all is
 *   well, 1 when something needs attention, and 2 when they could not check.
 */

import type { Command } from 'commander';

/** An error with the exit code the command should end with. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export const EXIT_OK = 0;
export const EXIT_ATTENTION = 1;
export const EXIT_ERROR = 2;

/**
 * True when a person can answer a prompt: stdin and stdout are terminals
 * and `CI` is not set.
 */
export const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;

/** A progress or diagnostic line, on stderr. */
export const info = (message = ''): void => {
  process.stderr.write(`${message}\n`);
};

/** One JSON document on stdout. */
export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Exits with `code` once stdout and stderr have handed over all they hold.
 * `process.exit` alone drops what a slow pipe hasn't read yet, which cuts a
 * long `--json` document short.
 */
export async function exitAfterOutput(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((resolve) => stream.write('', () => resolve()))));
  process.exit(code);
}

/**
 * Prints the error and exits: with its own code for a `CliError`, otherwise
 * with `fallbackCode`.
 */
export async function exitWithError(error: unknown, fallbackCode: number = 1): Promise<never> {
  const message = (error as Error)?.message ?? String(error);
  console.error(`Error: ${message}`);
  return exitAfterOutput(error instanceof CliError ? error.exitCode : fallbackCode);
}

/**
 * Ends quietly when the reader of stdout goes away (`| head`), instead of
 * failing with EPIPE.
 */
export function exitOnClosedStdout(): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }

    throw error;
  });
}

/**
 * Commander rejects a bad invocation (an unknown option, a missing value)
 * before the action runs, and exits 1, which a check uses for "needs
 * attention". Exit 2 for those instead, and 0 for `--help` and `--version`.
 */
export function exitWithErrorOnUsage(program: Command): void {
  for (const command of [program, ...program.commands]) {
    command.exitOverride((error) => process.exit(error.exitCode === 0 ? EXIT_OK : EXIT_ERROR));
  }
}
