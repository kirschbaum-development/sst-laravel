# Deploying

## What goes into the image

The deploy builds a Docker image of your project folder on your machine and uploads it to a private registry (ECR) in your AWS account. The Dockerfile copies the folder as it is: it doesn't run `composer install` or `npm run build`. Before you deploy:

```bash
composer install
npm run build
```

`vendor/` comes from your machine, dev packages included, and needs the PHP version it was installed with (`config.php`, which `init` sets to your local version). To ship a smaller image, build in CI with `composer install --no-dev --optimize-autoloader` (see [Deploying from GitHub Actions](#deploying-from-github-actions)).

The first deploy writes a `.dockerignore` when the project has none, so the image skips `.git`, `node_modules`, every `.env*` file (the containers get their own `.env`), local SQLite databases, uploads in `storage/app`, logs, and tests. Review it and commit it. Remove `node_modules` from it if the app needs it at runtime, for example for Inertia SSR. An existing `.dockerignore` is kept as it is; only the `.sst` lines are added.

## Deploy

To deploy your application, use the `sst-laravel deploy` command. You must be authenticated with AWS in your terminal session to deploy. With several named profiles, export `AWS_PROFILE=<name>` first.

```bash
npx sst-laravel deploy --stage {stage}
npx sst-laravel deploy --stage sandbox
npx sst-laravel deploy --stage production
```

Return the expected deployment alongside your existing outputs in `sst.config.ts`:

```ts
return {
  url: app.url,
  deployment: app.deployment,
};
```

For multiple `LaravelService` components, use `deployment: [app.deployment, otherApp.deployment]`.

`sst deploy` returns as soon as ECS accepts the new revision. `sst-laravel deploy` then checks exactly the services in this output, waits for their expected task definitions to finish rolling out with running tasks, verifies every private ECR image referenced by those definitions, and checks the app URL when present. Missing services, missing images, a rollback to an older revision, and an unrelated newer revision cannot pass. A service scaled to zero cannot pass the running check. It fails after 30 minutes if the rollout has not completed. See [`deploy`](cli.md#deploy). Pass `--no-wait` to explicitly skip verification.

The check needs `ecs:DescribeServices`, `ecs:ListServiceDeployments`, `ecs:DescribeServiceRevisions`, `ecs:DescribeTaskDefinition`, and `ecr:DescribeImages`. ECR calls use the account and region in each image reference. ECS calls use the app region (`--region` overrides it); register services and external tasks from that region. Errors reading AWS fail verification. This is a point-in-time availability check, not protection against subsequent ECR lifecycle expiration or manual deletion. Public ECR and other registries are not checked.

### External ECS tasks (opt in)

The library does not discover standalone tasks or unrelated services. To check the images of a separately declared `sst.aws.Task`, explicitly register its exact task definition:

```ts
return {
  url: app.url,
  deployment: {
    ...app.deployment,
    taskDefinitions: [taskRunner.taskDefinition],
  },
};
```

This checks every container's private ECR reference, including sidecars. Digest references check that digest; tag references check the tag's current image and cannot prove immutable identity. It does not run the task, alter its lifecycle, or check application-specific environment variables or IAM permissions.

> **Note:** If you're using `RemoteEnvVault` for secrets management, you should use `sst-laravel deploy` instead of `sst deploy` directly. This ensures secrets are fetched from AWS Secrets Manager before the Docker build.

## Readiness and status

Before deploying, check that the machine and app are ready:

```bash
npx sst-laravel doctor
```

It checks the tools (including a reachable Docker daemon), the AWS login and region, the app and its dependencies and built assets, `sst.config.ts`, the stage env file, trusted proxies, and that git ignores the env files. It never prints secret values. See [`doctor`](cli.md#doctor) for the full list.

`sst-laravel deploy` checks the rollout itself. After `npx sst deploy`, or to check a stage later, run `status`. It reads the stage's expected revisions from the `deployment` output, verifies their ECR images, and checks `/up`. Use `--wait` to keep checking while ECS rolls out:

```bash
npx sst-laravel status --stage production --wait
```

It fails when the last deployment was rolled back, even though the app still answers from the previous revision. It checks the app URL that the last `sst-laravel deploy` of the stage saved, from the `url` output of `sst.config.ts`. Pass `--url <url>` to check another address.

`deploy` saves expected targets in `.sst/laravel/deployments.json` before verification, even with `--no-wait` or if the check fails. A successful infrastructure deploy without that output clears the saved targets for its stage. `status` uses that record when `.sst/outputs.json` belongs to another stage. Keep this record to recheck a failed rollout. With only `--cluster` and no stage, `status` provides cluster diagnostics based on ECS history; it explicitly reports that expected revisions and image availability were not verified.

`/up` doesn't touch the database. To check the database and the migrations:

```bash
npx sst-laravel command:run migrate:status --stage production
```

Without a domain, the app URL is the load balancer address and serves `http://` only. `https://` times out until you add a domain.

## Upgrading from 0.7.1

The package supports SST `^4.17.1`. The Dockerfiles now use a read-only build-context mount to copy the app while excluding `.sst` entirely, including from intermediate image layers. Only the selected component's generated environment, deployment script, and service configuration are copied to their intended destinations. Existing `.dockerignore` rules remain effective.

No `docker-build` override is required for these Dockerfiles. SST 4.17.1 selects provider 0.0.14, whose embedded validator rejects `COPY --exclude` even with a modern Docker daemon and `# syntax=docker/dockerfile:1`. The regression suite calls that provider's actual Check RPC with SST-generated image inputs. Recon verified 0.0.22 for the old Dockerfiles; that is a working version, not an established minimum. SST selects providers before components run, so this package does not attempt to change provider versions inside `LaravelService`.

Managed web, worker, and Reverb images now default to `retainOnDelete: true`. SST 4.17.1's [shared Fargate image builder](https://github.com/sst/sst/blob/v4.17.1/platform/src/components/aws/fargate.ts) uses `docker-build.Image` for both services and tasks and feeds its digest into ECS. The provider's [delete implementation](https://github.com/pulumi/pulumi-docker-build/blob/v0.0.14/provider/internal/image.go) deletes remote manifests by digest. A replaced resource can therefore delete the replacement's image when both builds produce the same digest. ECS services, task definitions, and other resources are not retained by this change.

Upgrade in this order:

1. Update sst-laravel and add `deployment: app.deployment` to the existing outputs. Keep existing SST/provider pins and user transforms. Deploy once without changing provider versions or deliberately replacing image resources; this records retention in the existing image resources' state.
2. Only after that deployment succeeds, make a separate provider/SST upgrade if needed. A real Pulumi engine regression confirms that setting retention for the first time in the same operation that replaces an unretained image does **not** protect the old resource.
3. Run the default verified deploy (or `status --stage <stage> --wait`). If an image was already deleted, retention cannot restore it: rebuild and push the missing content, then recheck the exact task definition and digest.

If an app already pins 0.0.22, keep that pin during step 1; there is no need to downgrade. Standalone `sst.aws.Task` resources remain app-owned: set their image retention through their own `transform.image` hook and persist it before replacement. The library neither changes those resources nor adds Recon-specific checks.

Retained image manifests can continue to incur storage costs after replacement or stage removal. Cleanup belongs to the owner of SST's shared ECR repository: inventory active services, standalone tasks, and revisions needed for rollback before removing a digest. ECR lifecycle policies and manual deletion still apply; retention does not override them. Avoid blanket pruning of the shared repository. Experts who manage image ownership separately can explicitly set `opts.retainOnDelete = false` in the service block's `advanced.transform.image` hook, accepting the replacement risk. Image function/object transforms and user dependencies are preserved.

### Regression coverage and limits

- `npm test`: expected revisions, rollback without history, missing services/images, sidecars, opt-in external tasks, stage records, and transform preservation with mocked AWS responses.
- `npm run test:component`: real installed SST component graph and strict type checking; actual selected Pulumi Docker provider Check RPC for both Dockerfiles, with the old `--exclude` syntax as a negative control on 0.0.14. AWS resources and image builds are mocked. Install the selected provider plugin first, or set `SST_DOCKER_BUILD_PROVIDER` to its binary.
- `npm run test:lifecycle`: real Pulumi engine and a local deterministic registry stand-in; replaces two resources referencing the same digest, with and without previously persisted retention. Requires Pulumi (SST's installed binary works).
- `npm run test:containers`: real images and processes through Docker or Podman, including `.sst` exclusion, dotfiles, generated environment, and ownership. This alone cannot exercise Pulumi's parser.

These tests do not perform a live AWS provider upgrade, delete an ECR manifest, or induce an ECS rollback. Those AWS interactions remain mocked; the engine test models the provider's documented digest deletion. Upstream SST/Pulumi still own generic image replacement safety, provider parser upgrades, and protection for independently declared tasks.

## Removing a stage

```bash
npx sst remove --stage dev
```

It removes the stage's resources according to their retention settings. Managed image manifests are retained and may need later cleanup (see [Upgrading from 0.7.1](#upgrading-from-071)). With the config from `init`, a database and its data go too, except on `production`, where `removal: "retain"` keeps them. See the [SST docs](https://sst.dev/docs/reference/cli/#remove).

## PHP version and OPcache

The containers run PHP 8.4 unless you set `config.php`. The available versions are 8.1, 8.2, 8.3, 8.4, and 8.5. The images build on the [ServerSideUp PHP images](https://serversideup.net/open-source/docker-php/) v5, which don't support 7.4 and 8.0. OPcache is on in every container. Set `config.opcache` to `false` to turn it off:

```js
const app = new LaravelService('MyLaravelApp', {
  config: {
    php: 8.4,
    opcache: false,
  },
});
```

## Deployment script

A deployment script runs each time a container starts. Use it for migrations, caching, and similar steps:

```js
const app = new LaravelService('MyLaravelApp', {
  config: {
    deployment: {
      script: './infra/deploy.sh'
    },
  },
});
```

Custom deployment script example:

```bash
#!/bin/sh

# Exit on error
set -e

echo "🚀 Running Deployment Script..."

cd "$APP_BASE_DIR"

echo "🚀 Running PHP Artisan Optimize..."
php artisan optimize

echo "🚀 Running Laravel Migrations..."
php artisan migrate --force
```

Only run migrations once the stage has a persistent database. Otherwise, they have nowhere to run and the containers fail to start.

## Deploying from GitHub Actions

`sst-laravel github-iam` creates an IAM role that GitHub Actions can assume through OIDC, so your workflow deploys without stored AWS keys:

```bash
npx sst-laravel github-iam --branch main
```

It creates the GitHub OIDC provider in your AWS account if it's missing, creates the role, and prints the workflow steps to add. The role trusts only your repository (detected from the git remote, or set with `--repo`) and the branch you pass (all branches by default). It gets the `AdministratorAccess` policy, so restrict the branch to the ones that should deploy. See the [CLI reference](cli.md#github-iam) for all options.

The printed workflow deploys with `npx sst-laravel deploy`, so the job fails when ECS rolls the new revision back. A workflow that runs `npx sst deploy` stays green in that case: add a step with `npx sst-laravel status --stage production --wait` after it.
