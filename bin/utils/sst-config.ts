import * as fs from 'fs';
import * as path from 'path';

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

export function extractSstProjectName(configPath: string): string | null {
  const content = fs.readFileSync(configPath, 'utf-8');
  const match = content.match(/name\s*:\s*['"`]([^'"`]+)['"`]/);
  return match ? match[1] : null;
}

export function extractLaravelComponents(configPath: string): string[] {
  const content = fs.readFileSync(configPath, 'utf-8');
  const regex = /new\s+LaravelService\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const components: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    components.push(match[1]);
  }

  return components;
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

  if (envFile) {
    const cwd = process.cwd();
    const envFilePath = path.join(cwd, envFile);

    if (!fs.existsSync(envFilePath)) {
      throw new Error(`Environment file "${envFile}" not found. Please create the file or update your sst.config.ts configuration.`);
    }
  }
}
