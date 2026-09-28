/// <reference path="./../../../../.sst/platform/config.d.ts" />

import { Component } from "../../../../.sst/platform/src/components/component.js";
import { ComponentResourceOptions, Output, output } from "@pulumi/pulumi";
import { Input } from "../../../../.sst/platform/src/components/input.js";

export interface RemoteEnvVaultArgs {
  /**
   * The path in AWS Secrets Manager where environment variables will be stored.
   * Defaults to `/{app-name}/{stage}/env`.
   *
   * @example
   * ```js
   * new RemoteEnvVault("Env", {
   *   path: "/my-app/production/env",
   * });
   * ```
   */
  path?: Input<string>;
}

/**
 * The `RemoteEnvVault` component manages environment variables for your Laravel application
 * using AWS Secrets Manager.
 *
 * The secrets are managed via CLI commands:
 * - `sst-laravel env:push` - Push local .env file to AWS Secrets Manager
 * - `sst-laravel env:pull` - Pull secrets from AWS Secrets Manager to local file
 *
 * Large environment files are automatically split into multiple chunks to handle
 * AWS Secrets Manager's 64KB limit per secret.
 *
 * @example
 * ### Basic usage
 * ```js
 * const env = new RemoteEnvVault("Env");
 *
 * new LaravelService("Laravel", {
 *   config: {
 *     environment: {
 *       secrets: env,
 *     },
 *   },
 * });
 * ```
 *
 * @example
 * ### Custom path
 * ```js
 * const env = new RemoteEnvVault("Env", {
 *   path: "/custom/path/env",
 * });
 * ```
 *
 * @example
 * ### CLI workflow
 * ```bash
 * # Push secrets to AWS
 * sst-laravel env:push --stage production --input .env.production
 *
 * # Pull secrets from AWS
 * sst-laravel env:pull --stage production
 *
 * # Deploy (automatically fetches secrets)
 * sst-laravel deploy --stage production
 * ```
 */
export class RemoteEnvVault extends Component {
  private readonly _path: Output<string>;

  /**
   * RemoteEnvVault is a component provided by the sst-laravel package 
   * to manage environment variables for your Laravel application using AWS Secrets Manager, 
   * making it simple to manage your environment variables in a remote way that also works well with CI/CD pipelines.
   */
  constructor(
    name: string,
    args: RemoteEnvVaultArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    // Build the secret path: /{app-name}/{stage}/env
    const secretPath = args.path
      ? output(args.path)
      : output(`/${$app.name}/${$app.stage}/env`);

    this._path = secretPath;

    // Note: We don't create the secret here. Secrets are managed via CLI commands
    // (env:push, env:pull) which handle chunking for large environment files.
    // The deploy command fetches secrets before building the Docker image.

    this.registerOutputs({
      path: this._path,
    });
  }

  /**
   * The path in AWS Secrets Manager where environment variables are stored.
   */
  public get path(): Output<string> {
    return this._path;
  }
}

const __pulumiType = "sst:aws:RemoteEnvVault";
// @ts-expect-error
RemoteEnvVault.__pulumiType = __pulumiType;
