import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { resolveRegion } from './aws.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Find the package root directory by looking for package.json
 * This works whether running from source (bin/utils/) or compiled (dist/bin/utils/)
 */
export function getPackageRoot(): string {
  let dir = __dirname;

  // Traverse up until we find package.json
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  throw new Error('Could not find package root (package.json not found)');
}

/**
 * Get the path to a template file
 */
export function getTemplatePath(templateName: string): string {
  const packageRoot = getPackageRoot();
  return path.join(packageRoot, 'templates', templateName);
}

export function findSstConfig(): string | null {
  const cwd = process.cwd();
  const possiblePaths = [
    path.join(cwd, 'sst.config.ts'),
    path.join(cwd, 'sst.config.js'),
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

/**
 * The app name: the `name` the `app()` function of the config returns,
 * ignoring comments. Falls back to the first `name:` in the file.
 */
export function extractSstProjectName(configPath: string): string | null {
  const content = stripTsComments(fs.readFileSync(configPath, 'utf-8'));
  const namePattern = /\bname\s*:\s*['"`]([^'"`]+)['"`]/;
  const appFunction = content.match(/\bapp\s*(?::\s*(?:async\s+)?(?:function\s*)?)?\([^)]*\)\s*(?:=>\s*)?\(?\s*\{/);
  const match =
    (appFunction ? content.slice(appFunction.index! + appFunction[0].length).match(namePattern) : null) ??
    content.match(namePattern);

  return match ? match[1] : null;
}

/**
 * The region the config deploys to, when the `aws` provider sets it as a
 * literal (`providers: { aws: { region: "eu-west-1" } }`). Otherwise SST uses
 * the AWS CLI's region.
 */
export function extractAwsRegion(configPath: string): string | null {
  const content = stripTsComments(fs.readFileSync(configPath, 'utf-8'));
  const match = content.match(/\baws\s*:\s*\{[^{}]*?\bregion\s*:\s*['"`]([a-z0-9-]+)['"`]/);

  return match ? match[1] : null;
}

/**
 * The region the app is deployed to: `--region`, then the region in
 * sst.config.ts, then the AWS CLI's.
 */
export function resolveAppRegion(explicit?: string): string {
  const configPath = explicit ? null : findSstConfig();

  return resolveRegion(explicit ?? (configPath ? extractAwsRegion(configPath) ?? undefined : undefined));
}

function findLaravelComponentsInContent(content: string): string[] {
  const regex = /new\s+LaravelService\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const components: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    components.push(match[1]);
  }

  return components;
}

function resolveImportedFiles(content: string, sourceDir: string): string[] {
  const importRegex = /(?:await\s+)?import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const resolvedFiles: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];

    // Only resolve relative imports
    if (!importPath.startsWith('.')) {
      continue;
    }

    const resolved = resolveToFile(path.resolve(sourceDir, importPath));
    if (resolved) {
      resolvedFiles.push(resolved);
    }
  }

  return resolvedFiles;
}

function resolveToFile(filePath: string): string | null {
  // Try the path as-is (already has extension)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath;
  }

  // Try adding extensions
  for (const ext of ['.ts', '.js']) {
    const withExt = filePath + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // Try as directory with index file
  for (const ext of ['.ts', '.js']) {
    const indexFile = path.join(filePath, `index${ext}`);
    if (fs.existsSync(indexFile)) {
      return indexFile;
    }
  }

  return null;
}

function collectComponentsRecursively(
  filePath: string,
  visited: Set<string>,
): string[] {
  const resolved = path.resolve(filePath);
  if (visited.has(resolved)) {
    return [];
  }
  visited.add(resolved);

  const content = fs.readFileSync(resolved, 'utf-8');
  const components = findLaravelComponentsInContent(content);

  const importedFiles = resolveImportedFiles(content, path.dirname(resolved));
  for (const importedFile of importedFiles) {
    components.push(...collectComponentsRecursively(importedFile, visited));
  }

  return components;
}

export function extractLaravelComponents(configPath: string): string[] {
  const content = fs.readFileSync(configPath, 'utf-8');
  const components = findLaravelComponentsInContent(content);

  // Fast path: components found directly in the main config
  if (components.length > 0) {
    return components;
  }

  // Follow dynamic imports to find LaravelService in sub-files
  const visited = new Set<string>([path.resolve(configPath)]);
  const importedFiles = resolveImportedFiles(content, path.dirname(configPath));

  for (const importedFile of importedFiles) {
    components.push(...collectComponentsRecursively(importedFile, visited));
  }

  return [...new Set(components)];
}

export function extractEnvironmentFile(configPath: string, stage: string): string | null {
  const content = fs.readFileSync(configPath, 'utf-8');

  // Find the start of environment block
  const envMatch = content.match(/\benvironment\s*:\s*\{/);
  if (!envMatch || envMatch.index === undefined) {
    return null;
  }

  // Extract the environment block by counting braces
  const startIndex = envMatch.index + envMatch[0].length;
  let braceCount = 1;
  let endIndex = startIndex;

  for (let i = startIndex; i < content.length && braceCount > 0; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') braceCount--;
    endIndex = i;
  }

  const envBlock = content.substring(startIndex, endIndex);

  // Now find the file property within the environment block
  const fileMatch = envBlock.match(/\bfile\s*:\s*[`'"]([^`'"]+)[`'"]/);

  if (!fileMatch) {
    return null;
  }

  let envFile = fileMatch[1];

  // Replace ${$app.stage} with actual stage value
  envFile = envFile.replace(/\$\{?\$app\.stage\}?/g, stage);

  return envFile;
}

export function validateDeployment(stage: string): void {
  const configPath = findSstConfig();

  if (!configPath) {
    throw new Error('Could not find sst.config.ts or sst.config.js in current directory.');
  }

  const envFile = extractEnvironmentFile(configPath, stage);
  const secretsConfig = extractSecretsConfig(configPath);

  // Only validate env file if secrets are not configured
  if (envFile && !secretsConfig) {
    const cwd = process.cwd();
    const envFilePath = path.join(cwd, envFile);

    if (!fs.existsSync(envFilePath)) {
      throw new Error(`Environment file "${envFile}" not found. Please create the file or update your sst.config.ts configuration.`);
    }
  }
}

/**
 * Removes line and block comments so the regex detectors below only see
 * active code. Template files ship commented examples (e.g. a commented
 * `RemoteEnvVault`) that must not count as configuration.
 */
export function stripTsComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;{}(,])\/\/.*$/gm, '$1');
}

/**
 * Extract RemoteEnvVault secrets configuration from SST config
 * Returns the custom path if specified, or null if no RemoteEnvVault is used
 */
export function extractSecretsConfig(configPath: string): { path?: string } | null {
  const content = stripTsComments(fs.readFileSync(configPath, 'utf-8'));

  // Check if RemoteEnvVault is used
  const laravelEnvMatch = content.match(/new\s+RemoteEnvVault\s*\(/);
  if (!laravelEnvMatch) {
    return null;
  }

  // Check if secrets is configured in environment
  const secretsMatch = content.match(/secrets\s*:\s*(\w+)/);
  if (!secretsMatch) {
    return null;
  }

  // Try to extract custom path from RemoteEnvVault constructor
  const pathMatch = content.match(/new\s+RemoteEnvVault\s*\([^)]*path\s*:\s*['"`]([^'"`]+)['"`]/);

  return {
    path: pathMatch ? pathMatch[1] : undefined,
  };
}

const VAULT_PATH_HINT = 'Pass the Secrets Manager path with --path.';

export interface VaultPathOption {
  value: string;
  /** Written as a template literal, so `${$app.stage}` is interpolated. */
  template: boolean;
}

/**
 * The `path` option of every active `new RemoteEnvVault(...)` in the config,
 * as written, or `undefined` when the vault uses the default path. Throws
 * when the arguments can't be read from the file, so the CLI never guesses.
 */
export function extractVaultPathOptions(configPath: string): Array<VaultPathOption | undefined> {
  const content = stripTsComments(fs.readFileSync(configPath, 'utf-8'));
  const constructor = /new\s+RemoteEnvVault\s*\(/g;
  const paths: Array<VaultPathOption | undefined> = [];
  let match: RegExpExecArray | null;

  while ((match = constructor.exec(content)) !== null) {
    const args = readCallArguments(content, match.index + match[0].length);
    // Drop the component name, the first argument.
    const options = args.replace(/^\s*(?:(['"`])(?:\\.|(?!\1)[^\\])*\1|[\w$.]+)\s*,?/, '').trim();

    if (!options || !/\bpath\b/.test(options)) {
      if (options && !options.startsWith('{')) {
        throw new Error(`Could not read the RemoteEnvVault options in ${path.basename(configPath)}. ${VAULT_PATH_HINT}`);
      }

      paths.push(undefined);
      continue;
    }

    const literal = options.match(/\bpath\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)\s*[,}]/);

    if (!literal) {
      throw new Error(`The RemoteEnvVault path in ${path.basename(configPath)} is not a plain string. ${VAULT_PATH_HINT}`);
    }

    paths.push(
      literal[3] !== undefined
        ? { value: literal[3], template: true }
        : { value: literal[1] ?? literal[2], template: false },
    );
  }

  return paths;
}

/**
 * The Secrets Manager path the deploy reads the environment from: the
 * `RemoteEnvVault` `path` option with `$app.name` and `$app.stage` filled
 * in, or the default `/{app}/{stage}/env`.
 */
export function resolveVaultSecretPath(configPath: string, appName: string, stage: string): string {
  const resolved = new Set(
    extractVaultPathOptions(configPath).map((option) => {
      if (option === undefined) {
        return `/${appName}/${stage}/env`;
      }

      if (!option.template) {
        return option.value;
      }

      const value = option.value
        .replace(/\$\{\s*\$app\.stage\s*\}/g, stage)
        .replace(/\$\{\s*\$app\.name\s*\}/g, appName);

      if (value.includes('${')) {
        throw new Error(`The RemoteEnvVault path \`${option.value}\` uses values other than $app.name and $app.stage. ${VAULT_PATH_HINT}`);
      }

      return value;
    }),
  );

  if (resolved.size > 1) {
    throw new Error(`The SST config has RemoteEnvVaults with different paths (${[...resolved].join(', ')}). ${VAULT_PATH_HINT}`);
  }

  return resolved.values().next().value ?? `/${appName}/${stage}/env`;
}

/**
 * The text between the parentheses of a call, starting right after `(`.
 */
function readCallArguments(content: string, start: number): string {
  let depth = 1;

  for (let i = start; i < content.length; i++) {
    if (content[i] === '(') depth++;
    if (content[i] === ')') depth--;

    if (depth === 0) {
      return content.substring(start, i);
    }
  }

  return content.substring(start);
}
