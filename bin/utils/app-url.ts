import * as fs from 'fs';
import * as path from 'path';

/**
 * The app URL of each stage, saved by `deploy` so `status` can check the
 * health endpoint without `--url`. `.sst` is ignored by git.
 */
const SAVED_URLS_PATH = path.join('.sst', 'laravel', 'urls.json');

const isUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//.test(value);

/**
 * The outputs SST writes after a deploy, or nothing when there are none.
 */
export const readOutputs = (cwd: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.sst', 'outputs.json'), 'utf-8'));
  } catch {
    return {};
  }
};

/**
 * The app URLs from the outputs SST writes after a deploy. Only the plain
 * http load balancer addresses are returned: those are the ones that need
 * the "no https yet" note.
 */
export const findHttpOnlyUrls = (outputs: Record<string, unknown>): string[] =>
  Object.values(outputs).filter(
    (value): value is string =>
      typeof value === 'string' && /^http:\/\/[^/]*\.elb\.amazonaws\.com/.test(value),
  );

/**
 * The web URL from the SST outputs: the `url` output that `init` returns,
 * otherwise the load balancer address when there is only one.
 */
export const findAppUrl = (outputs: Record<string, unknown>): string | undefined => {
  if (isUrl(outputs.url)) {
    return outputs.url;
  }

  const loadBalancerUrls = findHttpOnlyUrls(outputs);
  return loadBalancerUrls.length === 1 ? loadBalancerUrls[0] : undefined;
};

const readSavedUrls = (cwd: string): Record<string, unknown> => {
  try {
    const urls = JSON.parse(fs.readFileSync(path.join(cwd, SAVED_URLS_PATH), 'utf-8'));
    return urls && typeof urls === 'object' && !Array.isArray(urls) ? urls : {};
  } catch {
    return {};
  }
};

/**
 * Saves the URL of the stage, or forgets it when the deploy has none, so
 * `status` never checks an address the stage no longer serves.
 */
export const saveAppUrl = (cwd: string, stage: string, url: string | undefined) => {
  const urls = readSavedUrls(cwd);

  if (url) {
    urls[stage] = url;
  } else if (stage in urls) {
    delete urls[stage];
  } else {
    return;
  }

  const target = path.join(cwd, SAVED_URLS_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(urls, null, 2)}\n`, 'utf-8');
};

export const readSavedAppUrl = (cwd: string, stage: string): string | undefined => {
  const url = readSavedUrls(cwd)[stage];
  return isUrl(url) ? url : undefined;
};
