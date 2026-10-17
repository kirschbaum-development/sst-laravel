/**
 * Reads and writes `.env` files the way Laravel (phpdotenv) reads them.
 *
 * Shared by the component and the CLI, and used inside the RemoteEnvFile
 * dynamic provider, so it must stay free of imports.
 */

/**
 * Escape sequences phpdotenv reads inside double-quoted values.
 */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  $: '$',
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
  v: '\v',
};

/**
 * Parse an .env file content into a key-value object.
 *
 * Quoted values are read the way phpdotenv reads them, so a file written by
 * `toEnvFileContent` reads back unchanged: single quotes are literal, double
 * quotes unescape `\\`, `\"`, `\$`, and `\n`-style sequences and may span
 * lines, and anything after the closing quote is ignored. Unquoted values are
 * taken as written up to the end of the line, and `${VAR}` references are
 * kept as they are.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Find the first = sign
    const equalIndex = line.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = parseEnvKey(line.substring(0, equalIndex));
    let rawValue = line.substring(equalIndex + 1).trimStart();

    // A double-quoted value continues until its closing quote. Without one,
    // the line is taken as written instead of swallowing the rest of the file.
    if (rawValue.startsWith('"') && findClosingDoubleQuote(rawValue) === -1) {
      let multiline = rawValue;
      let last = i;

      while (findClosingDoubleQuote(multiline) === -1 && last + 1 < lines.length) {
        multiline += '\n' + lines[++last];
      }

      if (findClosingDoubleQuote(multiline) !== -1) {
        rawValue = multiline;
        i = last;
      }
    }

    if (key) {
      result[key] = parseEnvValue(rawValue);
    }
  }

  return result;
}

/**
 * The variables Laravel ends up with when it loads an .env file, for when
 * they are passed to the containers as plain variables instead of a file.
 *
 * Unlike `parseEnvFile`, it follows what phpdotenv does on load (checked
 * against phpdotenv 5.6): double-quoted values may span lines, a `#` ends an
 * unquoted value, and `${VAR}` in unquoted and double-quoted values is
 * replaced with the variable from `environment` (the container's own
 * variables, which phpdotenv never overwrites) or from an earlier line, and
 * kept as written when neither has it. What phpdotenv rejects, such as an
 * unquoted value with whitespace, fails here too.
 */
export function loadEnvFile(content: string, environment: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  const reference = /\$\{([A-Za-z0-9_.]+)\}/g;
  const resolve = (sequence: string, name: string) => environment[name] ?? result[name] ?? sequence;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const fail = (key: string, problem: string) => {
    throw new Error(`The value of ${key} in the environment file ${problem}, which Laravel can't read.`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#') || !line.includes('=')) {
      continue;
    }

    const equalIndex = line.indexOf('=');
    const key = parseEnvKey(line.substring(0, equalIndex));
    let rawValue = line.substring(equalIndex + 1).trimStart();
    let value: string;

    if (rawValue.startsWith('"')) {
      let last = i;

      while (findClosingDoubleQuote(rawValue) === -1 && last + 1 < lines.length) {
        rawValue += '\n' + lines[++last];
      }

      i = last;
      const end = findClosingDoubleQuote(rawValue);

      if (end === -1) {
        fail(key, 'has no closing quote');
      }

      if (!/^\s*(#.*)?$/.test(rawValue.slice(end + 1))) {
        fail(key, 'has text after its closing quote');
      }

      value = rawValue.slice(1, end).replace(/\\(.)|\$\{([A-Za-z0-9_.]+)\}/gs, (sequence, char?: string, name?: string) =>
        name !== undefined ? resolve(sequence, name) : DOUBLE_QUOTED_ESCAPES[char!] ?? sequence);
    } else if (rawValue.startsWith("'")) {
      const end = rawValue.indexOf("'", 1);

      if (end === -1) {
        fail(key, 'has no closing quote on its line');
      }

      if (!/^\s*(#.*)?$/.test(rawValue.slice(end + 1))) {
        fail(key, 'has text after its closing quote');
      }

      value = rawValue.slice(1, end);
    } else {
      const unquoted = rawValue.split('#')[0].trim();

      if (/\s/.test(unquoted)) {
        fail(key, 'has whitespace without quotes');
      }

      value = unquoted.replace(reference, resolve);
    }

    if (key) {
      result[key] = value!;
    }
  }

  return result;
}

/**
 * Writes variables as the env file ECS reads (`environmentFiles`): one
 * `KEY=VALUE` per line, where everything after the first `=` is the value,
 * quotes and spaces included. Values that span lines can't be written.
 */
export function toEcsEnvFileContent(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value)) {
        throw new Error(`${key} spans lines, which an ECS environment file can't hold.`);
      }

      return `${key}=${value}\n`;
    })
    .join('');
}

/**
 * The variable's name, without `export`, and without the quotes phpdotenv
 * allows around it (`"APP_NAME"=Laravel`).
 */
function parseEnvKey(rawKey: string): string {
  const key = rawKey.trim().replace(/^export\s+/, '');

  return /^(["'])(.*)\1$/s.test(key) ? key.slice(1, -1) : key;
}

function parseEnvValue(rawValue: string): string {
  if (rawValue.startsWith("'")) {
    const end = rawValue.indexOf("'", 1);

    if (end !== -1) {
      return rawValue.slice(1, end);
    }
  }

  if (rawValue.startsWith('"')) {
    const end = findClosingDoubleQuote(rawValue);

    if (end !== -1) {
      // Unknown escape sequences keep their backslash.
      return rawValue
        .slice(1, end)
        .replace(/\\(.)/gs, (sequence, char: string) => DOUBLE_QUOTED_ESCAPES[char] ?? sequence);
    }
  }

  return rawValue.trimEnd();
}

/**
 * Index of the quote that closes a double-quoted value, skipping escaped
 * characters, or -1 when the value is not closed.
 */
function findClosingDoubleQuote(rawValue: string): number {
  for (let i = 1; i < rawValue.length; i++) {
    if (rawValue[i] === '\\') {
      i++;
    } else if (rawValue[i] === '"') {
      return i;
    }
  }

  return -1;
}

/**
 * Convert a key-value object to .env file content. The deploy writes the
 * containers' `.env` with it and `env:pull` writes local files with it, so a
 * pulled file reads the same as the deployed one.
 */
export function toEnvFileContent(vars: Record<string, string>): string {
  // Sort keys alphabetically for consistent output
  const sortedKeys = Object.keys(vars).sort();

  return sortedKeys
    .map((key) => {
      const value = vars[key];
      const needsQuoting =
        value.includes(' ') ||
        value.includes('"') ||
        value.includes("'") ||
        value.includes('\n') ||
        value.includes('$') ||
        value.includes('\\') ||
        value.includes('#');

      if (!needsQuoting) {
        return `${key}=${value}`;
      }

      // Single quotes are phpdotenv "raw literal" mode — no $ expansion, no escapes.
      // Use them whenever possible so randomly-generated secrets round-trip safely.
      if (!value.includes("'") && !value.includes('\n')) {
        return `${key}='${value}'`;
      }

      // Fall back to double quotes when the value itself contains a single quote
      // or newline. Escape \, $, and " so phpdotenv reads the literal value.
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/\$/g, '\\$')
        .replace(/"/g, '\\"');
      return `${key}="${escaped}"`;
    })
    .join('\n');
}
