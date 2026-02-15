import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
  DescribeSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * AWS Secrets Manager limit is 65,536 bytes.
 * We use 60KB as our threshold to leave some buffer.
 */
const MAX_SECRET_SIZE_BYTES = 60 * 1024;

/**
 * Metadata structure for chunked secrets.
 */
interface ChunkedSecretMetadata {
  version: number;
  chunked: boolean;
  chunks: number;
  totalKeys: number;
}

/**
 * Get the secret path for a given app and stage.
 * Format: /{app-name}/{stage}/env
 */
export function getSecretPath(appName: string, stage: string): string {
  return `/${appName}/${stage}/env`;
}

/**
 * List available stages for an app by inspecting Secrets Manager paths.
 */
export async function listAvailableStages(appName: string, region?: string): Promise<string[]> {
  const client = new SecretsManagerClient({ region });
  const stages = new Set<string>();
  const prefix = `/${appName}/`;
  const suffix = '/env';
  let nextToken: string | undefined;

  do {
    const command = new ListSecretsCommand({
      NextToken: nextToken,
      Filters: [
        {
          Key: 'name',
          Values: [prefix],
        },
      ],
    });

    const response = await client.send(command);

    if (response.SecretList) {
      for (const secret of response.SecretList) {
        if (!secret.Name) {
          continue;
        }

        if (!secret.Name.startsWith(prefix) || !secret.Name.endsWith(suffix)) {
          continue;
        }

        const parts = secret.Name.split('/');
        // Secrets are stored as /{app}/{stage}/env
        if (parts.length >= 4 && parts[2]) {
          stages.add(parts[2]);
        }
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return Array.from(stages).sort();
}

/**
 * Get the chunk path for a given secret path and chunk index.
 */
function getChunkPath(basePath: string, chunkIndex: number): string {
  return `${basePath}/${chunkIndex}`;
}

/**
 * Parse an .env file content into a key-value object.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Find the first = sign
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.substring(0, equalIndex).trim();
    let value = trimmed.substring(equalIndex + 1);

    // Handle quoted values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Convert a key-value object to .env file content.
 */
export function toEnvFileContent(vars: Record<string, string>): string {
  // Sort keys alphabetically for consistent output
  const sortedKeys = Object.keys(vars).sort();

  return sortedKeys
    .map((key) => {
      const value = vars[key];
      // Quote values that contain spaces, quotes, or special characters
      if (value.includes(' ') || value.includes('"') || value.includes("'") || value.includes('\n')) {
        // Escape existing double quotes and wrap in double quotes
        const escaped = value.replace(/"/g, '\\"');
        return `${key}="${escaped}"`;
      }
      return `${key}=${value}`;
    })
    .join('\n');
}

/**
 * Calculate the byte size of a JSON string.
 */
function getJsonByteSize(obj: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

/**
 * Split variables into chunks that fit within the AWS Secrets Manager limit.
 */
export function splitIntoChunks(vars: Record<string, string>): Record<string, string>[] {
  const sortedKeys = Object.keys(vars).sort();
  const chunks: Record<string, string>[] = [];
  let currentChunk: Record<string, string> = {};

  for (const key of sortedKeys) {
    const testChunk = { ...currentChunk, [key]: vars[key] };

    if (getJsonByteSize(testChunk) > MAX_SECRET_SIZE_BYTES) {
      // Current chunk is full, start a new one
      if (Object.keys(currentChunk).length > 0) {
        chunks.push(currentChunk);
        currentChunk = { [key]: vars[key] };
      } else {
        // Single variable exceeds limit - this is an edge case
        // We still add it, but it may fail on AWS side
        console.warn(`Warning: Variable "${key}" alone exceeds the secret size limit.`);
        chunks.push({ [key]: vars[key] });
        currentChunk = {};
      }
    } else {
      currentChunk = testChunk;
    }
  }

  // Don't forget the last chunk
  if (Object.keys(currentChunk).length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Check if variables need to be chunked.
 */
export function needsChunking(vars: Record<string, string>): boolean {
  return getJsonByteSize(vars) > MAX_SECRET_SIZE_BYTES;
}

/**
 * Get a secret value from AWS Secrets Manager.
 */
async function getSecretValue(
  client: SecretsManagerClient,
  secretPath: string
): Promise<string | null> {
  try {
    const command = new GetSecretValueCommand({
      SecretId: secretPath,
    });

    const response = await client.send(command);
    return response.SecretString || null;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return null;
    }
    throw error;
  }
}

/**
 * Check if a secret is using the chunked format.
 */
function isChunkedSecret(data: any): data is ChunkedSecretMetadata {
  return data && typeof data === 'object' && data.chunked === true && typeof data.chunks === 'number';
}

/**
 * Pull environment variables from AWS Secrets Manager.
 * Handles both legacy single secrets and chunked secrets.
 */
export async function pullSecrets(
  secretPath: string,
  region?: string
): Promise<Record<string, string> | null> {
  const client = new SecretsManagerClient({ region });

  const secretValue = await getSecretValue(client, secretPath);

  if (!secretValue) {
    return null;
  }

  const data = JSON.parse(secretValue);

  // Check if this is a chunked secret
  if (isChunkedSecret(data)) {
    return await pullChunkedSecrets(client, secretPath, data.chunks);
  }

  // Legacy format - direct key-value pairs
  return data;
}

/**
 * Pull and merge all chunks of a chunked secret.
 */
async function pullChunkedSecrets(
  client: SecretsManagerClient,
  basePath: string,
  chunkCount: number
): Promise<Record<string, string>> {
  const allVars: Record<string, string> = {};

  // Fetch all chunks in parallel
  const chunkPromises = Array.from({ length: chunkCount }, (_, i) =>
    getSecretValue(client, getChunkPath(basePath, i + 1))
  );

  const chunkValues = await Promise.all(chunkPromises);

  for (let i = 0; i < chunkValues.length; i++) {
    const chunkValue = chunkValues[i];
    if (chunkValue) {
      const chunkData = JSON.parse(chunkValue);
      Object.assign(allVars, chunkData);
    } else {
      console.warn(`Warning: Chunk ${i + 1} not found at ${getChunkPath(basePath, i + 1)}`);
    }
  }

  return allVars;
}

/**
 * Check if a secret exists in AWS Secrets Manager.
 */
export async function secretExists(
  secretPath: string,
  region?: string
): Promise<boolean> {
  const client = new SecretsManagerClient({ region });

  try {
    const command = new DescribeSecretCommand({
      SecretId: secretPath,
    });

    await client.send(command);
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return false;
    }
    throw error;
  }
}

/**
 * Create or update a secret in AWS Secrets Manager.
 */
async function upsertSecret(
  client: SecretsManagerClient,
  secretPath: string,
  secretValue: string,
  description: string,
  region?: string
): Promise<void> {
  const exists = await secretExists(secretPath, region);

  if (exists) {
    const command = new PutSecretValueCommand({
      SecretId: secretPath,
      SecretString: secretValue,
    });
    await client.send(command);
  } else {
    const command = new CreateSecretCommand({
      Name: secretPath,
      SecretString: secretValue,
      Description: description,
    });
    await client.send(command);
  }
}

/**
 * Delete a secret from AWS Secrets Manager.
 */
async function deleteSecret(
  client: SecretsManagerClient,
  secretPath: string
): Promise<void> {
  try {
    const command = new DeleteSecretCommand({
      SecretId: secretPath,
      ForceDeleteWithoutRecovery: true,
    });
    await client.send(command);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      // Secret doesn't exist, that's fine
      return;
    }
    throw error;
  }
}

/**
 * Find existing chunk secrets for a given base path.
 */
async function findExistingChunks(
  client: SecretsManagerClient,
  basePath: string
): Promise<string[]> {
  const chunks: string[] = [];

  try {
    // List secrets that match the chunk pattern
    const command = new ListSecretsCommand({
      Filters: [
        {
          Key: 'name',
          Values: [`${basePath}/`],
        },
      ],
    });

    const response = await client.send(command);

    if (response.SecretList) {
      for (const secret of response.SecretList) {
        if (secret.Name && secret.Name.startsWith(`${basePath}/`)) {
          chunks.push(secret.Name);
        }
      }
    }
  } catch (error) {
    // If listing fails, we'll just proceed without cleanup
    console.warn('Warning: Could not list existing chunks for cleanup.');
  }

  return chunks;
}

/**
 * Clean up old chunks that are no longer needed.
 */
async function cleanupOldChunks(
  client: SecretsManagerClient,
  basePath: string,
  newChunkCount: number
): Promise<void> {
  const existingChunks = await findExistingChunks(client, basePath);

  for (const chunkPath of existingChunks) {
    // Extract chunk number from path
    const match = chunkPath.match(/\/(\d+)$/);
    if (match) {
      const chunkNum = parseInt(match[1], 10);
      if (chunkNum > newChunkCount) {
        console.log(`Cleaning up old chunk: ${chunkPath}`);
        await deleteSecret(client, chunkPath);
      }
    }
  }
}

/**
 * Push environment variables to AWS Secrets Manager.
 * Automatically handles chunking for large env files.
 */
export async function pushSecrets(
  secretPath: string,
  vars: Record<string, string>,
  region?: string
): Promise<{ chunked: boolean; chunks: number }> {
  const client = new SecretsManagerClient({ region });

  if (!needsChunking(vars)) {
    // Small enough for a single secret - use legacy format for simplicity
    await upsertSecret(
      client,
      secretPath,
      JSON.stringify(vars),
      'Laravel environment variables',
      region
    );

    // Clean up any old chunks if we're switching from chunked to single
    await cleanupOldChunks(client, secretPath, 0);

    return { chunked: false, chunks: 1 };
  }

  // Need to chunk the secrets
  const chunks = splitIntoChunks(vars);

  console.log(`Environment file exceeds size limit. Splitting into ${chunks.length} chunks...`);

  // Create metadata secret
  const metadata: ChunkedSecretMetadata = {
    version: 1,
    chunked: true,
    chunks: chunks.length,
    totalKeys: Object.keys(vars).length,
  };

  await upsertSecret(
    client,
    secretPath,
    JSON.stringify(metadata),
    'Laravel environment variables (chunked metadata)',
    region
  );

  // Create chunk secrets in parallel
  const chunkPromises = chunks.map((chunk, index) =>
    upsertSecret(
      client,
      getChunkPath(secretPath, index + 1),
      JSON.stringify(chunk),
      `Laravel environment variables (chunk ${index + 1}/${chunks.length})`,
      region
    )
  );

  await Promise.all(chunkPromises);

  // Clean up any old chunks beyond the new count
  await cleanupOldChunks(client, secretPath, chunks.length);

  return { chunked: true, chunks: chunks.length };
}

/**
 * Get info about the current secret structure.
 */
export async function getSecretInfo(
  secretPath: string,
  region?: string
): Promise<{ exists: boolean; chunked: boolean; chunks: number; totalKeys: number } | null> {
  const client = new SecretsManagerClient({ region });

  const secretValue = await getSecretValue(client, secretPath);

  if (!secretValue) {
    return null;
  }

  const data = JSON.parse(secretValue);

  if (isChunkedSecret(data)) {
    return {
      exists: true,
      chunked: true,
      chunks: data.chunks,
      totalKeys: data.totalKeys,
    };
  }

  // Legacy format
  return {
    exists: true,
    chunked: false,
    chunks: 1,
    totalKeys: Object.keys(data).length,
  };
}
