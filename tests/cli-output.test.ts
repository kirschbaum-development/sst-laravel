import { describe, expect, it } from 'vitest';
import { findHttpOnlyUrls } from '../bin/commands/deploy';
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
