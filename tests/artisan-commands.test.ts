import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8');

const cliCommands = fs
  .readdirSync(path.join(root, 'bin/commands'))
  .flatMap((file) => [...read(`bin/commands/${file}`).matchAll(/new Command\('([^']+)'\)/g)].map((match) => match[1]))
  .sort();

const artisanCommands = fs
  .readdirSync(path.join(root, 'laravel/Console/Commands'))
  .filter((file) => file !== 'SstLaravelCommand.php')
  .map((file) => ({
    className: file.replace('.php', ''),
    subcommand: read(`laravel/Console/Commands/${file}`).match(/return '([^']+)';/)?.[1],
  }));

describe('artisan commands', () => {
  // `php artisan sst-laravel:<command>` runs the Node CLI command of the same name.
  it('cover every CLI command', () => {
    expect(artisanCommands.map(({ subcommand }) => subcommand).sort()).toEqual(cliCommands);
  });

  it('are all registered by the service provider', () => {
    const provider = read('laravel/SstLaravelServiceProvider.php');

    for (const { className } of artisanCommands) {
      expect(provider).toContain(`${className}::class`);
    }
  });
});
