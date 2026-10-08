import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseEnvFile, toEnvFileContent } from '../bin/utils/secrets-manager';
import { toEnvFileContent as toDeployedEnvFileContent } from '../src/remote-env-file';

const trickyValues: Record<string, string> = {
  PLAIN: 'Laravel',
  SPACE: 'My App',
  DOUBLE_QUOTE: 'pa"ss',
  SINGLE_QUOTE: "it's",
  DOLLAR: 'abc$def',
  REFERENCE: '${APP_NAME}',
  HASH: 'a#b',
  BACKSLASH: 'a\\b',
  LITERAL_BACKSLASH_N: 'line1\\nline2',
  NEWLINE: 'line1\nline2',
  EVERYTHING: 'a\\b$c"d\'e#f g\nh',
  EMPTY: '',
};

describe('parseEnvFile and toEnvFileContent', () => {
  it('reads back every value it writes', () => {
    expect(parseEnvFile(toEnvFileContent(trickyValues))).toEqual(trickyValues);
  });

  it('keeps values unchanged over repeated env:pull and env:push round trips', () => {
    let vars = trickyValues;

    for (let i = 0; i < 3; i++) {
      vars = parseEnvFile(toEnvFileContent(vars));
    }

    expect(vars).toEqual(trickyValues);
  });

  it('writes the same file as the deploy, so a pulled file matches the containers', () => {
    expect(toEnvFileContent(trickyValues)).toBe(toDeployedEnvFileContent(trickyValues));
  });
});

describe('parseEnvFile', () => {
  it('unescapes double-quoted values the way phpdotenv does', () => {
    expect(parseEnvFile('A="q\\"s\\\\b\\$d\\n"')).toEqual({ A: 'q"s\\b$d\n' });
  });

  it('keeps the backslash of an unknown escape sequence', () => {
    expect(parseEnvFile('A="x\\q"')).toEqual({ A: 'x\\q' });
  });

  it('reads single-quoted values literally', () => {
    expect(parseEnvFile("A='a\\nb$c\"d'")).toEqual({ A: 'a\\nb$c"d' });
  });

  it('reads a double-quoted value spanning several lines', () => {
    expect(parseEnvFile('A="line1\nline2"\nB=2')).toEqual({ A: 'line1\nline2', B: '2' });
  });

  it('ignores a comment after a quoted value', () => {
    expect(parseEnvFile('A="x" # comment\nB=\'y\' # comment')).toEqual({ A: 'x', B: 'y' });
  });

  it('reads the export prefix and Windows line endings', () => {
    expect(parseEnvFile('export A=1\r\nB="2"\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('keeps unquoted values as written', () => {
    expect(parseEnvFile('A=a#b\nB=My App  \nC=  spaced')).toEqual({ A: 'a#b', B: 'My App', C: 'spaced' });
  });

  it('takes an unterminated quote as written instead of reading the rest of the file', () => {
    expect(parseEnvFile('A="abc\nB=2')).toEqual({ A: '"abc', B: '2' });
  });

  it('skips comments and blank lines', () => {
    expect(parseEnvFile('# comment\n\n  # indented\nA=1')).toEqual({ A: '1' });
  });
});

describe('secrets-manager copies', () => {
  // The component can't import from bin/ and the CLI can't import from src/,
  // so the module is kept as two identical copies until the build is shared.
  it('keeps src/secrets-manager.ts identical to bin/utils/secrets-manager.ts', () => {
    const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf-8');

    expect(read('src/secrets-manager.ts')).toBe(read('bin/utils/secrets-manager.ts'));
  });
});
