import { describe, expect, it } from 'vitest';
import type { Task } from '@aws-sdk/client-ecs';
import { clusterNamePattern, findServiceTasks, taskServiceName } from '../bin/utils/ecs';

describe('clusterNamePattern', () => {
  const pattern = clusterNamePattern('shop', 'dev', 'My-Laravel-App');

  it('matches the cluster SST creates for the component', () => {
    expect(pattern.test('shop-dev-MyLaravelAppClusterCluster-hkxrtoaz')).toBe(true);
  });

  it.each([
    ['another app with the same component name', 'blog-dev-MyLaravelAppClusterCluster-hkxrtoaz'],
    ['a stage that starts the same', 'shop-development-MyLaravelAppClusterCluster-hkxrtoaz'],
    ['an app whose name ends the same', 'myshop-dev-MyLaravelAppClusterCluster-hkxrtoaz'],
    ['another component', 'shop-dev-OtherClusterCluster-hkxrtoaz'],
  ])('does not match %s', (_, name) => {
    expect(pattern.test(name)).toBe(false);
  });
});

const task = (service: string, container = service): Task => ({ group: `service:${service}`, containers: [{ name: container }] });

describe('clusterNamePattern without the app name', () => {
  it('matches any app, but still the exact stage and component', () => {
    const pattern = clusterNamePattern(null, 'dev', 'App');

    expect(pattern.test('shop-dev-AppClusterCluster-hkxrtoaz')).toBe(true);
    expect(pattern.test('shop-development-AppClusterCluster-hkxrtoaz')).toBe(false);
  });
});

describe('findServiceTasks', () => {
  const tasks = [task('App-Web'), task('App-Reverb'), task('App-queue'), task('App-web-sockets')];

  it('finds web, Reverb, and workers by their exact service name', () => {
    expect(findServiceTasks(tasks, 'web', 'App').map(taskServiceName)).toEqual(['App-Web']);
    expect(findServiceTasks(tasks, 'reverb', 'App').map(taskServiceName)).toEqual(['App-Reverb']);
    expect(findServiceTasks(tasks, 'queue', 'App').map(taskServiceName)).toEqual(['App-queue']);
    expect(findServiceTasks(tasks, 'web-sockets', 'App').map(taskServiceName)).toEqual(['App-web-sockets']);
  });

  it('takes `worker` as any worker when none is named that way', () => {
    expect(findServiceTasks(tasks, 'worker', 'App').map(taskServiceName)).toEqual(['App-queue', 'App-web-sockets']);
    expect(findServiceTasks([...tasks, task('App-worker')], 'worker', 'App').map(taskServiceName)).toEqual(['App-worker']);
  });

  it('finds nothing for an unknown service', () => {
    expect(findServiceTasks(tasks, 'missing', 'App')).toEqual([]);
  });

  it('falls back to the container names without the component (--cluster)', () => {
    expect(findServiceTasks(tasks, 'queue').map(taskServiceName)).toEqual(['App-queue']);
  });
});
