# Environment File Sources

`config.environment.file` makes a file the containers' environment. The deploy reads the file from disk when it starts, so the file can come from wherever your team keeps its values: fetch it in a step before `npx sst-laravel deploy`. This page shows how to fetch it from [S3](#s3), [1Password](#1password), and [a GitHub Actions secret](#a-github-actions-secret), on your machine and in CI.

To keep the file in AWS without a fetch step, use [`RemoteEnvVault`](environment-variables.md#aws-secrets-manager-remoteenvvault) instead: the deploy fetches it from AWS Secrets Manager itself.

## How it works

Keep the `file` entry that `init` creates:

```ts
config: {
  environment: {
    file: `.env.${$app.stage}`,
  },
},
```

Then fetch the file and deploy in one script, so a deploy never uses a stale copy. For example, `scripts/build.sh`:

```sh
#!/bin/sh
set -e

stage="$1"

# Fetch .env.$stage with one of the commands on this page.
aws s3 cp "s3://my-app-env-files/$stage.env" ".env.$stage"

npx sst-laravel deploy --stage "$stage"
```

Run it with `sh scripts/build.sh dev`.

- **Stop when the fetch fails.** When the file is missing, the deploy only warns, and the containers start without your variables. `set -e` stops the script at the first command that fails.
- **Keep the file out of Git and out of the image.** Check it with `git check-ignore .env.dev`. The `.dockerignore` that the first deploy writes skips every `.env*` file; keep that rule if you have your own. The image gets its `.env` from SST Laravel, not from the project folder.

## S3

An S3 bucket keeps one file per stage in your AWS account, for less than a cent a month. Create the bucket once, outside `sst.config.ts`: the deploy needs the file before SST runs, and `sst remove` would delete a bucket that the stage created.

```bash
aws s3 mb s3://my-app-env-files
aws s3api put-bucket-versioning --bucket my-app-env-files --versioning-configuration Status=Enabled
```

Bucket names are global, so pick a unique one. New buckets are private and encrypted by default. Versioning keeps the earlier copies, so you can go back after a bad change.

Upload the file after each change, and fetch it before each deploy:

```bash
aws s3 cp .env.dev s3://my-app-env-files/dev.env   # after a change
aws s3 cp s3://my-app-env-files/dev.env .env.dev   # before a deploy
```

Whoever deploys needs `s3:GetObject` on the bucket, and `s3:PutObject` to change the file. The role that [`github-iam`](deploying.md#deploying-from-github-actions) creates can do both. In GitHub Actions, fetch the file after the AWS credentials step:

```yaml
      - name: Fetch the environment file
        run: aws s3 cp s3://my-app-env-files/production.env .env.production
```

## 1Password

1Password can hold the values in a [1Password Environment](https://developer.1password.com/docs/environments/), which is built for environment variables, or in vault items that a template points to.

### 1Password Environments

Create an Environment for each stage in the 1Password desktop app, under **Developer**. You can import your `.env.dev` into it; then delete the plaintext copy.

**On your machine (Mac and Linux).** Mount the Environment as a [local `.env` file](https://developer.1password.com/docs/environments/local-env-file): in the Environment, select **Connect** next to **Local .env file**, and choose `.env.dev` in your project. The deploy reads it like any other file, so you don't need a fetch step. 1Password passes the contents to the reader through a named pipe, so the values are never written to disk. It asks you to approve the first read, and the file stops working when 1Password locks. Close the file in your editor before you deploy: the mount doesn't handle several readers at once.

**With the CLI and in CI.** `op environment read` prints an Environment as `KEY=value` lines. It's a beta command: it needs 1Password CLI 2.33.0-beta.02 or later, and stable releases don't have it yet. Copy the Environment ID from the desktop app (**Manage environment** > **Copy environment ID**):

```bash
op environment read <environment-id> > .env.dev
```

Laravel needs quotes around a value with spaces in `.env`, so check how such values come out the first time.

In CI, create a [service account](https://developer.1password.com/docs/service-accounts/) that can only read the Environments the job needs, and save its token as the `OP_SERVICE_ACCOUNT_TOKEN` secret:

```yaml
      - name: Install the 1Password CLI
        uses: 1password/install-cli-action@v4
        with:
          version: latest-beta

      - name: Fetch the environment file
        run: op environment read "$OP_ENVIRONMENT_ID" > .env.production
        env:
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
          OP_ENVIRONMENT_ID: ${{ vars.OP_ENVIRONMENT_ID }}
```

### Vault items and `op inject`

The stable CLI fills a template with values from items in your vaults. Commit a template, such as `env.dev.tpl`, with [secret references](https://developer.1password.com/docs/cli/secret-references) where the secret values go:

```ini
APP_NAME="My App"
APP_ENV=production
APP_KEY="{{ op://my-app-dev/laravel/app-key }}"
STRIPE_SECRET="{{ op://my-app-dev/stripe/secret }}"
```

Don't start its name with `.env.`: `sst-laravel doctor` expects every such file to be ignored by Git. Write the file before each deploy (`-f` replaces the previous one without asking):

```bash
op inject -f -i env.dev.tpl -o .env.dev
```

In CI, use a service account as above, with the stable CLI:

```yaml
      - name: Install the 1Password CLI
        uses: 1password/install-cli-action@v4

      - name: Fetch the environment file
        run: op inject -f -i env.production.tpl -o .env.production
        env:
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
```

## A GitHub Actions secret

Save the whole file as a repository secret (up to 48 KB), such as `ENV_PRODUCTION`, and write it before the deploy:

```yaml
      - name: Write the environment file
        run: printf '%s\n' "$ENV_FILE" > .env.production
        env:
          ENV_FILE: ${{ secrets.ENV_PRODUCTION }}
```

To change a value, edit your copy of the file and save the secret again with `gh secret set ENV_PRODUCTION < .env.production`. The copy on your machine and the secret can drift apart. When several people change the values, S3, 1Password, or `RemoteEnvVault` keep a single copy.

## Other tools

Any tool that can write a `.env` file works the same way. For example, with Doppler:

```bash
doppler secrets download --no-file --format env > .env.dev
```
