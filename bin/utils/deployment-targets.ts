import * as fs from 'fs';
import * as path from 'path';
import type { DeploymentManifest, DeploymentService } from '../../src/deployment.js';

export type ServiceTarget = DeploymentService;
export type DeploymentTargets = DeploymentManifest;

const SETUP = 'Return `deployment: app.deployment` from run() in sst.config.ts (use an array for multiple LaravelService components), then deploy again.';
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTaskDefinition = (value: unknown): value is string => isString(value) && /^arn:[^:]+:ecs:[^:]+:\d{12}:task-definition\/[^:]+:\d+$/.test(value);

/** Only the explicit deployment output is read; unrelated resources are never discovered. */
export function readDeploymentTargets(outputs: Record<string, unknown>, stage: string): DeploymentTargets {
  const manifests = Array.isArray(outputs.deployment) ? outputs.deployment : [outputs.deployment];
  const services: ServiceTarget[] = [];
  const taskDefinitions: string[] = [];
  let app: string | undefined;

  for (const manifest of manifests) {
    if (!manifest || manifest.version !== 1 || !isString(manifest.app) || manifest.stage !== stage ||
      !Array.isArray(manifest.services) || !Array.isArray(manifest.taskDefinitions) ||
      !manifest.taskDefinitions.every(isTaskDefinition) ||
      !manifest.services.every((service: ServiceTarget) => service &&
        isString(service.cluster) && isString(service.service) && isTaskDefinition(service.taskDefinition))) {
      throw new Error(`Missing, invalid, or wrong-stage deployment output for ${stage}. ${SETUP}`);
    }
    if (app && app !== manifest.app) throw new Error('Deployment outputs belong to different SST apps.');
    app = manifest.app;
    services.push(...manifest.services);
    taskDefinitions.push(...manifest.taskDefinitions);
  }

  if (!services.length) throw new Error(`No managed services in the deployment output. ${SETUP}`);
  const unique = new Map<string, ServiceTarget>();
  for (const service of services) {
    const key = `${service.cluster}/${service.service}`;
    if (unique.has(key) && unique.get(key)!.taskDefinition !== service.taskDefinition) {
      throw new Error(`Conflicting expected task definitions for ${service.service}.`);
    }
    unique.set(key, service);
  }
  return { version: 1, app: app!, stage, services: [...unique.values()], taskDefinitions: [...new Set(taskDefinitions)] };
}

const savedPath = (cwd: string) => path.resolve(cwd, '.sst/laravel/deployments.json');

function savedTargets(cwd: string): Record<string, DeploymentTargets> {
  const file = savedPath(cwd);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Save the expected revision even if verification fails, so status cannot accept a rollback. */
export function saveDeploymentTargets(cwd: string, targets: DeploymentTargets): void {
  const file = savedPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...savedTargets(cwd), [targets.stage]: targets }, null, 2) + '\n');
}

export function clearSavedDeploymentTargets(cwd: string, stage: string): void {
  const saved = savedTargets(cwd);
  if (!Object.prototype.hasOwnProperty.call(saved, stage)) return;
  delete saved[stage];
  fs.writeFileSync(savedPath(cwd), JSON.stringify(saved, null, 2) + '\n');
}

export function readSavedDeploymentTargets(cwd: string, stage: string): DeploymentTargets {
  return readDeploymentTargets({ deployment: savedTargets(cwd)[stage] }, stage);
}

/** A missing output must never silently fall back to a previous successful deployment. */
export function readStatusDeploymentTargets(cwd: string, outputs: Record<string, unknown>, stage: string): DeploymentTargets {
  const first = [outputs.deployment].flat()[0] as { stage?: unknown } | undefined;
  const current = readDeploymentTargets(outputs, isString(first?.stage) ? first.stage : stage);
  if (current.stage === stage) return current;
  const saved = readSavedDeploymentTargets(cwd, stage);
  if (saved.app !== current.app) throw new Error('Saved deployment targets belong to a different SST app. Deploy this stage again.');
  return saved;
}
