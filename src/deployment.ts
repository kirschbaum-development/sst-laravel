/** A service and the immutable task definition this deployment expects. */
export interface DeploymentService<T = string> {
  cluster: T;
  service: T;
  taskDefinition: T;
}

/** Public SST output contract. Resource IDs are Inputs in the component and strings in the CLI. */
export interface DeploymentManifest<T = string> {
  version: 1;
  app: string;
  stage: string;
  services: DeploymentService<T>[];
  /** Explicitly registered external task definitions: image checks only. */
  taskDefinitions: T[];
}
