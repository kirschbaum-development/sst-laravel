import { execSync } from 'child_process';

export function detectGitHubRepo(): string | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, '')}`;
    }

    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return `${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, '')}`;
    }

    return null;
  } catch {
    return null;
  }
}
