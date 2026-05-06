import { describe, expect, it } from 'vitest';
import { toEnvFileContent } from '../src/remote-env-file';

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
