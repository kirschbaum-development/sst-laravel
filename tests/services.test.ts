import { afterEach, describe, expect, it, vi } from 'vitest';
import { planServices, resolveReverbArgs } from '../src/services';

const plan = (args: Record<string, unknown>) =>
  planServices('App', args as any, { sitePath: '.', buildPath: '/build', reverb: resolveReverbArgs(args.reverb as any) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveReverbArgs', () => {
  it('fills in the defaults', () => {
    expect(resolveReverbArgs(true)).toEqual({ command: 'php artisan reverb:start', host: '0.0.0.0', port: 8080 });
    expect(resolveReverbArgs({ port: 6001 })).toMatchObject({ port: 6001, host: '0.0.0.0' });
    expect(resolveReverbArgs(false)).toBeUndefined();
  });
});

describe('planServices', () => {
  it('plans web, the workers, then Reverb', () => {
    const plans = plan({
      web: { size: 'medium', horizon: true },
      workers: [{ name: 'queue', scheduler: true }, {}],
      reverb: true,
    });

    expect(plans.map(({ kind, workerName, label, resourceName, image, buildPath }) => ({ kind, workerName, label, resourceName, image, buildPath }))).toEqual([
      { kind: 'web', workerName: undefined, label: 'web', resourceName: 'App-Web', image: 'web', buildPath: '/build/web' },
      { kind: 'worker', workerName: 'queue', label: 'workers[queue]', resourceName: 'App-queue', image: 'worker', buildPath: '/build/worker-queue' },
      { kind: 'worker', workerName: 'worker-2', label: 'workers[worker-2]', resourceName: 'App-worker-2', image: 'worker', buildPath: '/build/worker-worker-2' },
      { kind: 'reverb', workerName: undefined, label: 'reverb', resourceName: 'App-Reverb', image: 'worker', buildPath: '/build/worker-reverb' },
    ]);
    expect(plans[0].serviceArgs).toEqual({ cpu: '1 vCPU', memory: '2 GB' });
    expect(Object.keys(plans[0].tasks)).toEqual(['laravel-horizon']);
    expect(Object.keys(plans[1].tasks)).toEqual(['laravel-scheduler']);
    expect(plans[3].tasks).toEqual({ 'laravel-reverb': { command: 'php artisan reverb:start' } });
  });

  it('gives web the default load balancer, redirecting to HTTPS with a domain', () => {
    const [web] = plan({ web: { domain: 'example.com', healthCheck: { path: '/up' } } });

    expect(web.loadBalancer).toEqual({
      domain: 'example.com',
      ports: [
        { listen: '80/http', redirect: '443/https' },
        { listen: '443/https', forward: '8080/http' },
      ],
      health: { '8080/http': { path: '/up' } },
    });
  });

  it('gives Reverb a load balancer on its port, and workers none', () => {
    const plans = plan({ workers: [{ name: 'queue' }], reverb: { port: 6001 } });

    expect(plans[0].loadBalancer).toBeUndefined();
    expect(plans[1].loadBalancer).toMatchObject({
      ports: [{ listen: '80/http', forward: '6001/http' }],
      health: { '6001/http': { path: '/apps', successCodes: '200-499' } },
    });
  });

  it('uses advanced.loadBalancer instead of the default', () => {
    const custom = { ports: [{ listen: '80/http', forward: '9000/http' }] };
    const [web] = plan({ web: { advanced: { loadBalancer: custom } } });

    expect(web.loadBalancer).toBe(custom);
    expect(web.serviceArgs).not.toHaveProperty('loadBalancer');
  });

  it('keeps the block transform apart from the service args', () => {
    const transform = { service: { desiredCount: 2 } };
    const [web] = plan({ web: { advanced: { transform, architecture: 'arm64' } } });

    expect(web.transform).toBe(transform);
    expect(web.serviceArgs).toEqual({ architecture: 'arm64' });
  });

  it('silences the nginx access logs of web only', () => {
    const plans = plan({ web: { accessLogs: false }, workers: [{ name: 'queue' }] });

    expect(plans[0].environment).toEqual({ NGINX_ACCESS_LOG: '/dev/null' });
    expect(plans[1].environment).toEqual({});
  });

  it('warns about deprecated keys with the block label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    plan({ workers: [{ name: 'queue', architecture: 'arm64' }] });

    expect(warn).toHaveBeenCalledWith('[sst-laravel] workers[queue].architecture is deprecated. Use workers[queue].advanced.architecture instead.');
  });

  it('rejects a component name that is not a single folder name', () => {
    expect(() => planServices('../App', {} as any, { sitePath: '.', buildPath: '/build' })).toThrow('Invalid LaravelService name');
  });

  it('rejects two workers with the same name', () => {
    expect(() => plan({ workers: [{ name: 'queue' }, { name: 'queue' }] })).toThrow('Two workers are named "queue"');
  });

  it('rejects an unsafe worker name before planning anything', () => {
    expect(() => plan({ workers: [{ name: '../escape' }] })).toThrow('Invalid worker name');
  });
});
