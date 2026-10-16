import { describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnvFile, toEcsEnvFileContent, toEnvFileContent } from '../src/dotenv';

describe('toEnvFileContent', () => {
  it('renders plain alphanumeric values without quotes', () => {
    const out = toEnvFileContent({ APP_NAME: 'Laravel' });
    expect(out).toBe('APP_NAME=Laravel');
  });

  it('single-quotes values containing a space (single quotes are the safer default)', () => {
    const out = toEnvFileContent({ APP_NAME: 'My App' });
    expect(out).toBe("APP_NAME='My App'");
  });

  it('single-quotes values containing a $ so phpdotenv does not expand them', () => {
    const out = toEnvFileContent({ SECRET: 'abc$DEF' });
    expect(out).toBe("SECRET='abc$DEF'");
  });

  it('single-quotes values containing a backslash', () => {
    const out = toEnvFileContent({ SECRET: 'abc\\def' });
    expect(out).toBe("SECRET='abc\\def'");
  });

  it('single-quotes values containing a # so phpdotenv does not treat it as a comment', () => {
    const out = toEnvFileContent({ SECRET: 'foo#bar' });
    expect(out).toBe("SECRET='foo#bar'");
  });

  it('falls back to double quotes with escapes when value contains both $ and a single quote', () => {
    const out = toEnvFileContent({ SECRET: "ab$c'def" });
    expect(out).toBe('SECRET="ab\\$c\'def"');
  });

  it('escapes backslashes, dollars, and double quotes when falling back to double quotes', () => {
    const out = toEnvFileContent({ SECRET: 'a\\b$c"d\'e' });
    expect(out).toBe('SECRET="a\\\\b\\$c\\"d\'e"');
  });

  // Verified manually that this exact rendered output round-trips through
  // vlucas/phpdotenv unchanged, while the old unquoted output `REDIS_PASSWORD=…$…`
  // was truncated by phpdotenv at the first `$` (variable expansion).
  it('renders the real-world Redis password fixture as a single-quoted literal', () => {
    const password = 'GMa<P>06c$48BWByFaRm6O$#<>mGt^Lq';
    const out = toEnvFileContent({ REDIS_PASSWORD: password });
    expect(out).toBe("REDIS_PASSWORD='GMa<P>06c$48BWByFaRm6O$#<>mGt^Lq'");
  });

  it('single-quotes a value that contains only double quotes (no apostrophe, no newline)', () => {
    const out = toEnvFileContent({ MOTD: 'say "hi"' });
    expect(out).toBe("MOTD='say \"hi\"'");
  });

  it('preserves existing behavior for single quotes inside values (no $)', () => {
    const out = toEnvFileContent({ MOTD: "it's fine" });
    expect(out).toBe('MOTD="it\'s fine"');
  });

  it('falls back to double quotes for values containing newlines and escapes them as literal newlines', () => {
    const out = toEnvFileContent({ KEY: 'line1\nline2' });
    expect(out).toBe('KEY="line1\nline2"');
  });

  it('sorts keys alphabetically and joins with newlines', () => {
    const out = toEnvFileContent({ B: '2', A: '1', C: '3' });
    expect(out).toBe('A=1\nB=2\nC=3');
  });
});

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

describe('loadEnvFile', () => {
  it('expands ${VAR} from the container first, then from earlier lines, the way phpdotenv does', () => {
    const content = [
      'APP_NAME="My App"',
      'REVERB_HOST=file-host',
      'VITE_APP_NAME="${APP_NAME}"',
      'VITE_REVERB_HOST=${REVERB_HOST}',
      'LATER="${DEFINED_BELOW}"',
      'DEFINED_BELOW=too-late',
    ].join('\n');

    expect(loadEnvFile(content, { REVERB_HOST: 'ws.example.com' })).toEqual({
      APP_NAME: 'My App',
      REVERB_HOST: 'file-host',
      VITE_APP_NAME: 'My App',
      VITE_REVERB_HOST: 'ws.example.com',
      LATER: '${DEFINED_BELOW}',
      DEFINED_BELOW: 'too-late',
    });
  });

  it('keeps single-quoted and escaped references literal', () => {
    expect(loadEnvFile("A=x\nB='${A}'\nC=\"\\${A}\"\nD=\"a\\\\${A}\"")).toEqual({ A: 'x', B: '${A}', C: '${A}', D: 'a\\x' });
  });

  it('ends an unquoted value at a #, as phpdotenv does', () => {
    expect(loadEnvFile("APP_DEBUG=false # off in production\nHASH=abc#def ghi\nEMPTY=\nCOMMENTED= # nothing\nQUOTED='a' # c"))
      .toEqual({ APP_DEBUG: 'false', HASH: 'abc', EMPTY: '', COMMENTED: '', QUOTED: 'a' });
  });

  it('reads double-quoted values spanning lines', () => {
    expect(loadEnvFile('KEY="-----BEGIN\nline\\tend\n-----END"\nNEXT=1')).toEqual({
      KEY: '-----BEGIN\nline\tend\n-----END',
      NEXT: '1',
    });
  });

  it('rejects what phpdotenv rejects instead of guessing', () => {
    expect(() => loadEnvFile('APP_NAME=My App')).toThrow('APP_NAME');
    expect(() => loadEnvFile('APP_KEY="unterminated')).toThrow('APP_KEY');
    expect(() => loadEnvFile("RAW='first\nsecond'")).toThrow('RAW');
    expect(() => loadEnvFile('NAME="a" trailing')).toThrow('NAME');
  });
});

describe('toEcsEnvFileContent', () => {
  it('writes values raw, since ECS keeps quotes and spaces as part of the value', () => {
    expect(toEcsEnvFileContent({ APP_NAME: 'My App', QUOTED: '"x"', URL: 'a=b#c' })).toBe('APP_NAME=My App\nQUOTED="x"\nURL=a=b#c\n');
  });

  it('refuses values that span lines', () => {
    expect(() => toEcsEnvFileContent({ KEY: 'a\nb' })).toThrow('KEY');
  });
});
