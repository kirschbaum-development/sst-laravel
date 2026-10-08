import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findAppUrl, findHttpOnlyUrls, readSavedAppUrl, saveAppUrl } from '../bin/utils/app-url';
import { stripAnsi } from '../bin/commands/logs';
import { isLoadBalancerHttpsUrl } from '../bin/commands/status';

describe('findHttpOnlyUrls', () => {
  it('returns the plain-http load balancer addresses from the SST outputs', () => {
    expect(
      findHttpOnlyUrls({
        url: 'http://dev-my-app-web-123.us-east-1.elb.amazonaws.com',
        ws: 'https://ws.example.com',
        count: 2,
      }),
    ).toEqual(['http://dev-my-app-web-123.us-east-1.elb.amazonaws.com']);
  });

  it('returns nothing when the app has a domain', () => {
    expect(findHttpOnlyUrls({ url: 'https://app.example.com' })).toEqual([]);
  });
});

describe('findAppUrl', () => {
  it('prefers the url output', () => {
    expect(
      findAppUrl({
        ws: 'http://dev-my-app-reverb-456.us-east-1.elb.amazonaws.com',
        url: 'https://app.example.com',
      }),
    ).toBe('https://app.example.com');
  });

  it('falls back to the only load balancer address', () => {
    expect(findAppUrl({ web: 'http://dev-my-app-web-123.us-east-1.elb.amazonaws.com' })).toBe(
      'http://dev-my-app-web-123.us-east-1.elb.amazonaws.com',
    );
  });

  it('returns nothing when it cannot tell which address is the app', () => {
    expect(
      findAppUrl({
        web: 'http://dev-my-app-web-123.us-east-1.elb.amazonaws.com',
        ws: 'http://dev-my-app-reverb-456.us-east-1.elb.amazonaws.com',
      }),
    ).toBeUndefined();
    expect(findAppUrl({ url: 'not a url' })).toBeUndefined();
    expect(findAppUrl({})).toBeUndefined();
  });
});

describe('saveAppUrl', () => {
  it('saves the URL of each stage for status', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-url-'));

    saveAppUrl(app, 'dev', 'http://dev-my-app-web-123.us-east-1.elb.amazonaws.com');
    saveAppUrl(app, 'production', 'https://app.example.com');

    expect(readSavedAppUrl(app, 'dev')).toBe('http://dev-my-app-web-123.us-east-1.elb.amazonaws.com');
    expect(readSavedAppUrl(app, 'production')).toBe('https://app.example.com');
    expect(readSavedAppUrl(app, 'staging')).toBeUndefined();
  });

  it('forgets the URL when a deploy of the stage has none', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-url-'));

    saveAppUrl(app, 'dev', 'https://dev.example.com');
    saveAppUrl(app, 'dev', undefined);

    expect(readSavedAppUrl(app, 'dev')).toBeUndefined();
  });

  it('writes nothing when there is nothing to save', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-url-'));

    saveAppUrl(app, 'dev', undefined);

    expect(fs.existsSync(path.join(app, '.sst'))).toBe(false);
  });
});

describe('isLoadBalancerHttpsUrl', () => {
  it('only flags https on a load balancer address', () => {
    expect(isLoadBalancerHttpsUrl('https://dev-my-app-123.us-east-1.elb.amazonaws.com')).toBe(true);
    expect(isLoadBalancerHttpsUrl('http://dev-my-app-123.us-east-1.elb.amazonaws.com')).toBe(false);
    expect(isLoadBalancerHttpsUrl('https://app.example.com')).toBe(false);
    expect(isLoadBalancerHttpsUrl('not a url')).toBe(false);
  });
});

describe('stripAnsi', () => {
  it('removes color codes and keeps the text', () => {
    expect(stripAnsi('\x1b[32mINFO\x1b[0m Server started \x1b[1;31mERROR\x1b[0m')).toBe('INFO Server started ERROR');
  });
});
