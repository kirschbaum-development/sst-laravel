import { execSync } from 'child_process';

const FALLBACK_REGION = 'us-east-1';

/**
 * The AWS profile the commands run with, for messages. Empty when the
 * default profile (or plain environment credentials) is used.
 */
export const activeProfile = (): string | undefined => process.env.AWS_PROFILE || undefined;

/**
 * The region the AWS CLI would use: `AWS_REGION`/`AWS_DEFAULT_REGION`, then
 * the active profile's config. Null when none is set.
 */
export const configuredRegion = (): string | null => {
  if (process.env.AWS_REGION) {
    return process.env.AWS_REGION;
  }

  if (process.env.AWS_DEFAULT_REGION) {
    return process.env.AWS_DEFAULT_REGION;
  }

  try {
    const configured = execSync('aws configure get region', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    })
      .toString()
      .trim();

    return configured || null;
  } catch {
    // No AWS CLI or no region in the profile.
    return null;
  }
};

/**
 * Resolves the region the same way the AWS CLI does, so named profiles
 * (`AWS_PROFILE=team aws ...`) land in their own region instead of us-east-1:
 * an explicit value, then the configured region, then us-east-1.
 */
export const resolveRegion = (explicit?: string): string => explicit || configuredRegion() || FALLBACK_REGION;

export const REGION_OPTION_HELP = 'AWS region (defaults to AWS_REGION, then the active profile, then us-east-1)';
